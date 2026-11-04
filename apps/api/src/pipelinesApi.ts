// Pipelines API (#156). Mounted under /api with requireSession; writes and controls are admin-only.
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  createPipeline,
  deletePipeline,
  pipelineInputSchema,
  pipelineProblems,
  pipelines,
  suggestPipelineNodes,
  updatePipeline,
} from '../../../packages/core/src/pipelines.js';
import {
  backfillPipeline,
  cancelPipelineRun,
  pipelineRuns,
  rerunFrom,
  retryNode,
  skipNode,
  startPipelineRun,
} from '../../../packages/core/src/pipelineEngine.js';

export const pipelinesRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change or run pipelines');
};
const pub = ({ _id, ownerId, ...rest }: Record<string, any>) => ({ id: _id, ...rest });
const runSummary = { graph: 0 } as const;

pipelinesRouter.get('/pipelines', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const list = await pipelines().find({ ownerId }).sort({ name: 1 }).toArray();
  const last = await pipelineRuns()
    .aggregate<{ _id: string; run: Record<string, any> }>([
      { $match: { ownerId } },
      { $sort: { createdAt: -1 } },
      { $project: runSummary },
      { $group: { _id: '$pipelineId', run: { $first: '$$ROOT' } } },
    ])
    .toArray();
  const by = new Map(last.map((l) => [l._id, pub(l.run)]));
  res.json(list.map((p) => ({ ...pub(p), lastRun: by.get(p._id) ?? null })));
});
pipelinesRouter.post('/pipelines', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res.status(201).json(pub(await createPipeline(req.principal!.tenantId, req.body, req.principal!.user._id)));
});
// Validate a draft without saving: errors block saving, warnings are advice.
pipelinesRouter.post('/pipelines/validate', async (req, res) => {
  const parsed = pipelineInputSchema.safeParse(req.body ?? {});
  if (!parsed.success)
    return void res.json({
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'pipeline'}: ${i.message}`),
      warnings: [],
    });
  const id = typeof req.query.id === 'string' ? req.query.id : undefined;
  res.json(await pipelineProblems(req.principal!.tenantId, parsed.data, id));
});
// "Generate from dependencies".
pipelinesRouter.get('/pipelines/suggest', async (req, res) => {
  const names =
    typeof req.query.transforms === 'string' && req.query.transforms
      ? req.query.transforms.split(',')
      : undefined;
  res.json({ nodes: await suggestPipelineNodes(req.principal!.tenantId, names) });
});
pipelinesRouter.get('/pipelines/:id', async (req, res) => {
  const p = await pipelines().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!p) throw new HttpError(404, 'Pipeline not found');
  res.json(pub(p));
});
pipelinesRouter.put('/pipelines/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res.json(
    pub(
      await updatePipeline(req.principal!.tenantId, String(req.params.id), req.body, req.principal!.user._id),
    ),
  );
});
pipelinesRouter.delete('/pipelines/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  await deletePipeline(req.principal!.tenantId, String(req.params.id));
  res.status(204).end();
});
const period = z
  .string()
  .regex(/^\d{4}-(\d{2}(-\d{2})?|W\d{2})$/, 'A period id: 2026-11-03, 2026-W45 or 2026-11');
pipelinesRouter.post('/pipelines/:id/run', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const body = z.object({ period: period.optional() }).parse(req.body ?? {});
  const { run, created } = await startPipelineRun(req.principal!.tenantId, String(req.params.id), {
    ...body,
    requestedBy: req.principal!.user._id,
  });
  res.status(created ? 202 : 200).json({ ...pub(run), created });
});
pipelinesRouter.post('/pipelines/:id/backfill', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const body = z
    .object({ from: period, to: period, parallelism: z.number().int().min(1).max(4).optional() })
    .parse(req.body ?? {});
  const r = await backfillPipeline(req.principal!.tenantId, String(req.params.id), {
    ...body,
    requestedBy: req.principal!.user._id,
  });
  res
    .status(202)
    .json({ backfillId: r.backfillId, queued: r.queued.map((x) => x.period.id), skipped: r.skipped });
});
pipelinesRouter.get('/pipelines/:id/runs', async (req, res) => {
  const runs = await pipelineRuns()
    .find({ ownerId: req.principal!.tenantId, pipelineId: String(req.params.id) }, { projection: runSummary })
    .sort({ 'period.start': -1, createdAt: -1 })
    .limit(100)
    .toArray();
  res.json(runs.map(pub));
});
pipelinesRouter.get('/pipeline-runs/:runId', async (req, res) => {
  const r = await pipelineRuns().findOne({ _id: String(req.params.runId), ownerId: req.principal!.tenantId });
  if (!r) throw new HttpError(404, 'Pipeline run not found');
  res.json(pub(r));
});
pipelinesRouter.post('/pipeline-runs/:runId/cancel', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res.json(pub(await cancelPipelineRun(req.principal!.tenantId, String(req.params.runId))));
});
pipelinesRouter.post('/pipeline-runs/:runId/nodes/:node/:action', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const [owner, runId, node] = [req.principal!.tenantId, String(req.params.runId), String(req.params.node)];
  const action = String(req.params.action);
  const run =
    action === 'retry'
      ? await retryNode(owner, runId, node)
      : action === 'rerun'
        ? await rerunFrom(owner, runId, node)
        : action === 'skip'
          ? await skipNode(owner, runId, node, String(req.body?.reason ?? ''))
          : undefined;
  if (!run) throw new HttpError(404, 'Unknown action (retry, rerun or skip)');
  res.json(pub(run));
});
