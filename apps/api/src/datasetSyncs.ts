import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../../packages/core/src/security.js';
import { catalogView, catalogById, TICKER_PRESETS } from '../../../packages/core/src/datasetCatalog.js';
import {
  datasetSyncs as syncsCol,
  datasetSyncRuns,
  datasetSyncInput,
  enqueueManualRun,
  probeDatasetDepth,
  syncQueue,
  fmpLimiter,
  effectivePriority,
  datasetBulkInput,
  applyDatasetSyncBulk,
  type DatasetSync,
} from '../../../packages/core/src/datasetSync.js';
import { z } from 'zod';
import {
  exportDatasetSyncConfig,
  planDatasetSyncImport,
  applyDatasetSyncImport,
} from '../../../packages/core/src/datasetSyncConfig.js';

/** Backend FMP -> workspace-MongoDB dataset syncs. Mounted under /api with requireSession. */
export const datasetSyncRouter = Router();

const publicSync = ({ _id, ...rest }: DatasetSync) => ({ id: _id, ...rest });
const assertAdmin = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change dataset syncs');
};

datasetSyncRouter.get('/datasets/catalog', (_req, res) => {
  res.json({
    datasets: catalogView(),
    presets: TICKER_PRESETS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
  });
});

async function listSyncs(ownerId: string) {
  const items = await syncsCol().find({ ownerId }).sort({ createdAt: -1 }).toArray();
  // Flag syncs with an in-flight run (ignoring rows orphaned by a restart) so the table can show it.
  const running = await datasetSyncRuns()
    .find({ ownerId, status: 'running', startedAt: { $gt: new Date(Date.now() - 12 * 3600 * 1000) } })
    .project<{ syncId: string }>({ syncId: 1 })
    .toArray();
  const busy = new Set(running.map((r) => r.syncId));
  const q = syncQueue.status();
  const queued = new Set(q.queued.map((j) => j.id));
  return items.map((s) => ({
    ...publicSync(s),
    running: busy.has(s._id) || q.running.some((j) => j.id === s._id),
    queued: queued.has(s._id),
    effectivePriority: effectivePriority(s),
  }));
}
// The studio auto-loads `/datasetSyncs` (collections key); `/dataset-syncs` is the REST alias.
datasetSyncRouter.get('/datasetSyncs', async (req, res) =>
  res.json(await listSyncs(req.principal!.tenantId)),
);
datasetSyncRouter.get('/dataset-syncs', async (req, res) =>
  res.json(await listSyncs(req.principal!.tenantId)),
);

// The background sync queue and the shared FMP limiter, for the Syncs page.
datasetSyncRouter.get('/dataset-syncs/queue', (_req, res) => {
  res.json({ ...syncQueue.status(), fmpWaiting: fmpLimiter.waiting(), fmpIntervalMs: fmpLimiter.interval });
});

// YAML export of sync configurations (all, or `?ids=a,b`). Registered before `/:id`.
datasetSyncRouter.get('/dataset-syncs/export', async (req, res) => {
  const ids = typeof req.query.ids === 'string' && req.query.ids ? req.query.ids.split(',') : undefined;
  const { yaml } = await exportDatasetSyncConfig(req.principal!.tenantId, ids);
  const stamp = new Date().toISOString().slice(0, 10);
  res
    .type('application/yaml')
    .set('Content-Disposition', `attachment; filename="dataset-syncs-${stamp}.yaml"`)
    .send(yaml);
});

const importInput = z.object({
  yaml: z.string().min(1).max(5_000_000),
  mode: z.enum(['merge', 'replace']).default('merge'),
  dryRun: z.boolean().default(true),
});
// Import YAML. dryRun (default) only returns the plan; otherwise applies it all-or-nothing.
datasetSyncRouter.post('/dataset-syncs/import', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const { yaml, mode, dryRun } = importInput.parse(req.body);
  const ownerId = req.principal!.tenantId;
  if (dryRun)
    return void res.json({ applied: false, plan: await planDatasetSyncImport(ownerId, yaml, mode) });
  const result = await applyDatasetSyncImport(ownerId, yaml, mode, req.principal!.user._id);
  res.json(result); // applied: false + plan.errors when nothing was written
});

datasetSyncRouter.get('/dataset-syncs/:id', async (req, res) => {
  const doc = await syncsCol().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!doc) throw new HttpError(404, 'Dataset sync not found');
  res.json(publicSync(doc));
});

datasetSyncRouter.post('/dataset-syncs', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const body = datasetSyncInput.parse(req.body);
  if (!catalogById.has(body.dataset)) throw new HttpError(400, `Unknown dataset: ${body.dataset}`);
  const now = new Date();
  const doc: DatasetSync = {
    ...body,
    _id: randomUUID(),
    ownerId: req.principal!.tenantId,
    createdAt: now,
    updatedAt: now,
    createdBy: req.principal!.user._id,
  };
  await syncsCol().insertOne(doc);
  res.status(201).json(publicSync(doc));
});

datasetSyncRouter.put('/dataset-syncs/:id', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const body = datasetSyncInput.parse(req.body);
  if (!catalogById.has(body.dataset)) throw new HttpError(400, `Unknown dataset: ${body.dataset}`);
  const id = String(req.params.id);
  const ownerId = req.principal!.tenantId;
  // Editing a sync clears nextRunAt so the (possibly new) schedule re-seeds on the next tick.
  const updated = await syncsCol().updateOne(
    { _id: id, ownerId },
    { $set: { ...body, updatedAt: new Date() }, $unset: { nextRunAt: '' } },
  );
  if (!updated.matchedCount) throw new HttpError(404, 'Dataset sync not found');
  res.json(publicSync((await syncsCol().findOne({ _id: id, ownerId }))!));
});

datasetSyncRouter.delete('/dataset-syncs/:id', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  await syncsCol().deleteOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  res.status(204).end();
});

const probeInput = z.object({
  dataset: z.string().min(1),
  connectionId: z.string().min(1),
  symbol: z.string().max(20).optional(),
  statementPeriod: z.enum(['quarter', 'annual']).optional(),
  /** When given, the result is also stored on the sync (shown in its form). */
  syncId: z.string().optional(),
});
// Plan-depth probe (#77): how much history FMP really returns for one symbol on the current plan.
datasetSyncRouter.post('/dataset-syncs/probe-depth', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const input = probeInput.parse(req.body);
  const result = await probeDatasetDepth(req.principal!.tenantId, input);
  if (input.syncId)
    await syncsCol().updateOne(
      { _id: input.syncId, ownerId: req.principal!.tenantId },
      { $set: { depthProbe: result } },
    );
  res.json(result);
});

// Apply one action to many syncs at once (Datasets toolbar). `run` returns immediately; the selected
// syncs then run one after another in the background.
datasetSyncRouter.post('/dataset-syncs/bulk', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const input = datasetBulkInput.parse(req.body);
  res.json(await applyDatasetSyncBulk(req.principal!.tenantId, input));
});

// Trigger an immediate one-off sync (runs in the background; poll /runs for status).
datasetSyncRouter.post('/dataset-syncs/:id/run', async (req, res) => {
  assertAdmin(req.principal!.user.role);
  const doc = await syncsCol().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!doc) throw new HttpError(404, 'Dataset sync not found');
  const queued = enqueueManualRun(doc);
  res.status(202).json({ started: queued, alreadyQueued: !queued });
});

datasetSyncRouter.get('/dataset-syncs/:id/runs', async (req, res) => {
  const runs = await datasetSyncRuns()
    .find({ ownerId: req.principal!.tenantId, syncId: String(req.params.id) })
    .sort({ startedAt: -1 })
    .limit(20)
    .toArray();
  res.json(runs.map(({ _id, ...r }) => ({ id: _id, ...r })));
});
