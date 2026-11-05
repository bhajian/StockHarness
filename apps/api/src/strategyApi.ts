// Strategy plugins and evaluations API (M3). Mounted under /api with requireSession; writes are admin-only.
import { Router } from 'express';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  createStrategyPlugin,
  deleteStrategyPlugin,
  listStrategyPluginVersions,
  strategyPlugins,
  updateStrategyPlugin,
} from '../../../packages/core/src/strategyPlugins.js';
import {
  getEvaluation,
  listEvaluations,
  startEvaluation,
  trialCount,
} from '../../../packages/core/src/evaluations.js';

export const strategyRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change strategy plugins');
};
const pub = ({ _id, ownerId, ...rest }: Record<string, any>) => ({ id: _id, ...rest });

strategyRouter.get('/strategy-plugins', async (req, res) => {
  const list = await strategyPlugins()
    .find({ ownerId: req.principal!.tenantId }, { projection: { code: 0 } })
    .sort({ name: 1 })
    .toArray();
  res.json(list.map(pub));
});
strategyRouter.post('/strategy-plugins', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res
    .status(201)
    .json(pub(await createStrategyPlugin(req.principal!.tenantId, req.body, req.principal!.user._id)));
});
strategyRouter.get('/strategy-plugins/:id', async (req, res) => {
  const p = await strategyPlugins().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!p) throw new HttpError(404, 'Strategy plugin not found');
  res.json(pub(p));
});
strategyRouter.put('/strategy-plugins/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const p = await updateStrategyPlugin(
    req.principal!.tenantId,
    String(req.params.id),
    req.body,
    req.principal!.user._id,
    { note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined },
  );
  res.json(pub(p));
});
strategyRouter.delete('/strategy-plugins/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  await deleteStrategyPlugin(req.principal!.tenantId, String(req.params.id));
  res.status(204).end();
});
strategyRouter.get('/strategy-plugins/:id/versions', async (req, res) => {
  const rows = await listStrategyPluginVersions(req.principal!.tenantId, String(req.params.id));
  res.json(rows.map(pub));
});

// Evaluations (#104): start one (202, poll GET /evaluations/:id), list them, read one record.
strategyRouter.post('/evaluations', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const { evaluation, done } = await startEvaluation(req.principal!.tenantId, req.body, {
    userId: req.principal!.user._id,
  });
  done.catch(() => undefined); // failures are recorded on the evaluation
  res.status(202).json(pub(evaluation));
});
strategyRouter.get('/evaluations', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const list = await listEvaluations(ownerId, {
    plugin: typeof req.query.plugin === 'string' ? req.query.plugin : undefined,
    theoryId: typeof req.query.theoryId === 'string' ? req.query.theoryId : undefined,
  });
  res.json({ trials: await trialCount(ownerId), items: list.map(pub) });
});
strategyRouter.get('/evaluations/:id', async (req, res) => {
  res.json(pub(await getEvaluation(req.principal!.tenantId, String(req.params.id))));
});
