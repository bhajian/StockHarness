// Layer 2 Transforms API (#89). Mounted under /api with requireSession; writes are admin-only.
import { Router } from 'express';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  createTransform,
  deleteTransform,
  restoreTransformVersion,
  transformVersions,
  transforms,
  updateTransform,
} from '../../../packages/core/src/transforms.js';
import { z } from 'zod';
import { requestTransformRun, transformRuns } from '../../../packages/core/src/transformRunner.js';

export const transformsRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change transforms');
};
const pub = ({ _id, ownerId, ...rest }: Record<string, any>) => ({ id: _id, ...rest });

transformsRouter.get('/transforms', async (req, res) => {
  const list = await transforms().find({ ownerId: req.principal!.tenantId }).sort({ name: 1 }).toArray();
  res.json(list.map(pub));
});
transformsRouter.post('/transforms', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res
    .status(201)
    .json(pub(await createTransform(req.principal!.tenantId, req.body, req.principal!.user._id)));
});
transformsRouter.get('/transforms/:id', async (req, res) => {
  const t = await transforms().findOne({ _id: String(req.params.id), ownerId: req.principal!.tenantId });
  if (!t) throw new HttpError(404, 'Transform not found');
  res.json(pub(t));
});
transformsRouter.put('/transforms/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res.json(
    pub(
      await updateTransform(
        req.principal!.tenantId,
        String(req.params.id),
        req.body,
        req.principal!.user._id,
      ),
    ),
  );
});
transformsRouter.delete('/transforms/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  await deleteTransform(req.principal!.tenantId, String(req.params.id));
  res.status(204).end();
});
const runInput = z.object({
  range: z.enum(['last_day', 'custom', 'full']).default('last_day'),
  start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  end: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
// Run now (#90): last day, a custom range, or a full backfill in yearly chunks (run in order).
transformsRouter.post('/transforms/:id/run', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const runs = await requestTransformRun(req.principal!.tenantId, String(req.params.id), {
    ...runInput.parse(req.body ?? {}),
    requestedBy: req.principal!.user._id,
  });
  res.status(202).json(runs.map(pub));
});
transformsRouter.get('/transforms/:id/runs', async (req, res) => {
  const runs = await transformRuns()
    .find(
      { ownerId: req.principal!.tenantId, transformId: String(req.params.id) },
      { projection: { stdout: 0, stderr: 0 } },
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  res.json(runs.map(pub));
});
transformsRouter.get('/transform-runs/:runId', async (req, res) => {
  const r = await transformRuns().findOne({
    _id: String(req.params.runId),
    ownerId: req.principal!.tenantId,
  });
  if (!r) throw new HttpError(404, 'Run not found');
  res.json(pub(r));
});

transformsRouter.get('/transforms/:id/versions', async (req, res) => {
  const list = await transformVersions()
    .find(
      { ownerId: req.principal!.tenantId, transformId: String(req.params.id) },
      { projection: { spec: 0 } },
    )
    .sort({ version: -1 })
    .toArray();
  res.json(list.map(pub));
});
transformsRouter.get('/transforms/:id/versions/:version', async (req, res) => {
  const v = await transformVersions().findOne({
    _id: `${String(req.params.id)}:${Number(req.params.version)}`,
    ownerId: req.principal!.tenantId,
  });
  if (!v) throw new HttpError(404, 'Version not found');
  res.json(pub(v));
});
transformsRouter.post('/transforms/:id/versions/:version/restore', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res.json(
    pub(
      await restoreTransformVersion(
        req.principal!.tenantId,
        String(req.params.id),
        Number(req.params.version),
        req.principal!.user._id,
      ),
    ),
  );
});
