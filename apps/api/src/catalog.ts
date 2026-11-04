// Schema Catalog API (#84). Mounted under /api with requireSession.
import { Router } from 'express';
import { z } from 'zod';
import { collectionCoverage } from '../../../packages/core/src/catalogCoverage.js';
import { lineage } from '../../../packages/core/src/lineage.js';
import { dataHealth } from '../../../packages/core/src/dataHealth.js';
import { driftAlerts } from '../../../packages/core/src/ingestValidation.js';
import { collection } from '../../../packages/core/src/db.js';
import { HttpError, safeError } from '../../../packages/core/src/security.js';
import {
  agentView,
  catalogEntries,
  catalogMarkdown,
  listCatalog,
  patchCatalogEntry,
  refreshCatalog,
  refreshCatalogEntry,
} from '../../../packages/core/src/schemaCatalog.js';

export const catalogRouter = Router();
const publicEntry = ({ _id, ownerId, ...rest }: Record<string, unknown>) => rest;
const entryOr404 = async (ownerId: string, name: string) => {
  const e = await catalogEntries().findOne({ ownerId, collection: name });
  if (!e) throw new HttpError(404, `No catalog entry for ${name}`);
  return e;
};

catalogRouter.get('/catalog', async (req, res) => {
  const entries = await listCatalog(req.principal!.tenantId);
  // The list omits per-field stats; open an entry for those.
  res.json(entries.map(({ fields, ...e }) => ({ ...publicEntry(e), fieldCount: fields.length })));
});
catalogRouter.post('/catalog/refresh', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can refresh the catalog');
  const name = typeof req.body?.collection === 'string' ? req.body.collection : undefined;
  if (name) return void res.json(publicEntry(await refreshCatalogEntry(req.principal!.tenantId, name)));
  res.json({ refreshed: await refreshCatalog(req.principal!.tenantId) });
});
catalogRouter.post('/catalog/export', async (req, res) => {
  const names: string[] | undefined = Array.isArray(req.body?.collections) ? req.body.collections : undefined;
  const entries = (await listCatalog(req.principal!.tenantId)).filter(
    (e) => !names || names.includes(e.collection),
  );
  res.type('text/markdown').send(catalogMarkdown(entries));
});
// Data health (#86): freshness, coverage, DQ, gaps, failed syncs/transforms, pipelines, top-bar indicator.
catalogRouter.get('/datasets/health', async (req, res) => {
  const days = Math.min(250, Math.max(10, Number(req.query.days) || 60));
  res.json(await dataHealth(req.principal!.tenantId, { days }));
});
// Schema drift alerts (#83): list, and resolve (the next drifted response re-opens it).
catalogRouter.get('/datasets/drift', async (req, res) => {
  const all = req.query.all === '1';
  const list = await driftAlerts()
    .find({ ownerId: req.principal!.tenantId, ...(all ? {} : { resolved: false }) })
    .sort({ lastSeenAt: -1 })
    .limit(500)
    .toArray();
  res.json(list.map(({ _id, ownerId, ...d }) => ({ id: _id, ...d })));
});
catalogRouter.post('/datasets/drift/:id/resolve', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can resolve drift alerts');
  const r = await driftAlerts().findOneAndUpdate(
    { _id: String(req.params.id), ownerId: req.principal!.tenantId },
    { $set: { resolved: true } },
    { returnDocument: 'after' },
  );
  if (!r) throw new HttpError(404, 'Drift alert not found');
  await refreshCatalogEntry(req.principal!.tenantId, r.collection).catch(() => undefined);
  res.json({ id: r._id, resolved: true });
});
// One collection's gap strip over the last N expected sessions; computes coverage if needed (202 meanwhile).
catalogRouter.get('/datasets/health/:collection/gaps', async (req, res) => {
  const name = String(req.params.collection);
  await entryOr404(req.principal!.tenantId, name);
  const { coverage } = await collectionCoverage(req.principal!.tenantId, name);
  if (!coverage) return void res.status(202).json({ computing: true });
  const days = Math.min(250, Math.max(10, Number(req.query.days) || 90));
  const { expected } = await dataHealth(req.principal!.tenantId, { days });
  const byDate = new Map(coverage.daily.dates.map((d, i) => [d, coverage.daily.series.rows?.[i] ?? null]));
  res.json({ collection: name, cells: expected.map((d) => ({ date: d, rows: byDate.get(d) ?? 0 })) });
});
// Lineage (#97): syncs -> collections -> transforms -> collections, with freshness per node.
catalogRouter.get('/catalog/lineage', async (req, res) => {
  res.json(await lineage(req.principal!.tenantId));
});
catalogRouter.get('/catalog/:collection', async (req, res) => {
  res.json(publicEntry(await entryOr404(req.principal!.tenantId, String(req.params.collection))));
});
// Rows and symbols per day plus a year × week grid (#87); 202 while it is computed in the background.
catalogRouter.get('/catalog/:collection/coverage', async (req, res) => {
  const name = String(req.params.collection);
  await entryOr404(req.principal!.tenantId, name);
  const { coverage, computing } = await collectionCoverage(req.principal!.tenantId, name, {
    refresh: req.query.refresh === '1',
  });
  if (!coverage) return void res.status(202).json({ computing: true });
  const { _id, ownerId, ...rest } = coverage;
  res.json({ ...rest, computing });
});
catalogRouter.get('/catalog/:collection/agent-view', async (req, res) => {
  res.json(agentView(await entryOr404(req.principal!.tenantId, String(req.params.collection))));
});
const patchInput = z.object({
  description: z.string().max(4000).optional(),
  grain: z.string().max(500).optional(),
  fields: z
    .record(z.object({ description: z.string().max(2000).optional(), unit: z.string().max(60).optional() }))
    .optional(),
  caveats: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{2,60}$/),
        severity: z.enum(['info', 'warn', 'blocking']),
        text: z.string().min(1).max(1000),
      }),
    )
    .max(50)
    .optional(),
  dismissedCaveats: z.array(z.string().max(60)).max(50).optional(),
});
catalogRouter.patch('/catalog/:collection', async (req, res) => {
  if (req.principal!.user.role !== 'admin')
    throw new HttpError(403, 'Only administrators can edit the catalog');
  const name = String(req.params.collection);
  await entryOr404(req.principal!.tenantId, name);
  res.json(publicEntry(await patchCatalogEntry(req.principal!.tenantId, name, patchInput.parse(req.body))));
});

/** Startup and daily: refresh every workspace that has dataset syncs. */
export async function refreshAllCatalogs() {
  const owners = (await collection('dataset_syncs').distinct('ownerId')) as string[];
  for (const o of owners)
    await refreshCatalog(o).catch((e) => console.warn('Catalog refresh failed:', safeError(e)));
}
