// Ideas API (#118): the human view of the research loop's theories. Mounted under /api with requireSession;
// actions, comments and reproduce are admin-only.
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  actOnIdea,
  commentOnIdea,
  compareIdeas,
  getIdea,
  ideaCode,
  ideaDebate,
  ideaEvaluations,
  ideaExportNames,
  listIdeas,
  reproduceIdea,
} from '../../../packages/core/src/ideas.js';
import { getTheory } from '../../../packages/core/src/theories.js';
import { exportObjects } from './objects.js';

export const ideasRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can act on ideas');
};
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v) || undefined);

ideasRouter.get('/ideas', async (req, res) => {
  const q = req.query;
  res.json(
    await listIdeas(req.principal!.tenantId, {
      status: str(q.status),
      family: str(q.family),
      side: str(q.side),
      profile: str(q.profile),
      horizonMin: num(q.horizonMin),
      horizonMax: num(q.horizonMax),
      data: str(q.data),
      gatesVersion: num(q.gatesVersion),
      q: str(q.q),
      sort: (str(q.sort) as 'dsr' | 'sharpe' | 'recent' | 'excess') ?? 'dsr',
      limit: num(q.limit),
      offset: num(q.offset),
    }),
  );
});
// Registered before /ideas/:id.
ideasRouter.get('/ideas/compare', async (req, res) => {
  const ids = String(req.query.ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  res.json(await compareIdeas(req.principal!.tenantId, ids));
});
ideasRouter.get('/ideas/:id', async (req, res) => {
  res.json(await getIdea(req.principal!.tenantId, String(req.params.id)));
});
ideasRouter.get('/ideas/:id/evaluations', async (req, res) => {
  res.json(await ideaEvaluations(req.principal!.tenantId, String(req.params.id)));
});
ideasRouter.get('/ideas/:id/debate', async (req, res) => {
  res.json(await ideaDebate(req.principal!.tenantId, String(req.params.id)));
});
ideasRouter.get('/ideas/:id/code', async (req, res) => {
  res.json(await ideaCode(req.principal!.tenantId, String(req.params.id), num(req.query.version)));
});
const actionInput = z.object({
  action: z.enum(['approve', 'park', 'reject', 'send_back', 'resume']),
  comment: z.string().max(8000).default(''),
});
ideasRouter.post('/ideas/:id/actions', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const { action, comment } = actionInput.parse(req.body ?? {});
  res.json(
    await actOnIdea(req.principal!.tenantId, String(req.params.id), action, comment, req.principal!.user._id),
  );
});
ideasRouter.post('/ideas/:id/comments', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const text = z.object({ text: z.string().min(1).max(8000) }).parse(req.body).text;
  res.json(
    await commentOnIdea(req.principal!.tenantId, String(req.params.id), text, req.principal!.user._id),
  );
});
ideasRouter.post('/ideas/:id/reproduce', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const evaluationId = str(req.body?.evaluationId);
  res.json(
    await reproduceIdea(
      req.principal!.tenantId,
      String(req.params.id),
      evaluationId,
      req.principal!.user._id,
    ),
  );
});
/** The idea as YAML records: the theory with its debate, its plugin with every version, and its evaluations. */
ideasRouter.get('/ideas/:id/export', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  const t = await getTheory(ownerId, String(req.params.id));
  const names = await ideaExportNames(ownerId, t._id);
  const { yaml } = await exportObjects(ownerId, ['StrategyPlugin', 'Evaluation', 'Theory'], names, {
    withHistory: true,
  });
  res
    .type('application/yaml')
    .set('Content-Disposition', `attachment; filename="idea-T-${t.number}.yaml"`)
    .send(yaml);
});
