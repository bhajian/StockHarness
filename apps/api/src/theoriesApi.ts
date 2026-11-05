// Theories API (#110). Mounted under /api with requireSession. People act as the `human` role here; agents move
// theories through the lifecycle MCP tools (#112), which carry their own roles.
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../packages/core/src/security.js';
import { THEORY_STATES } from '../../../packages/core/src/theoryLifecycle.js';
import {
  createTheory,
  editTheory,
  getTheory,
  lifecycleCaps,
  listTheories,
  transitionTheory,
} from '../../../packages/core/src/theories.js';

export const theoriesRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change theories');
};
const pub = ({ _id, ownerId, ...rest }: Record<string, any>) => ({
  id: _id,
  ref: `T-${rest.number}`,
  ...rest,
});
const human = (req: any) => ({ role: 'human' as const, userId: req.principal!.user._id });

theoriesRouter.get('/theories', async (req, res) => {
  const list = await listTheories(req.principal!.tenantId, {
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    family: typeof req.query.family === 'string' ? req.query.family : undefined,
  });
  res.json({ caps: await lifecycleCaps(req.principal!.tenantId), items: list.map(pub) });
});
theoriesRouter.get('/theories/:id', async (req, res) => {
  res.json(pub(await getTheory(req.principal!.tenantId, String(req.params.id))));
});
theoriesRouter.post('/theories', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const { submit, reasoning, ...content } = req.body ?? {};
  const t = await createTheory(req.principal!.tenantId, content, human(req), {
    submit: submit === true,
    reasoning: typeof reasoning === 'string' ? reasoning : undefined,
  });
  res.status(201).json(pub(t));
});
theoriesRouter.patch('/theories/:id', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const { reasoning, ...patch } = req.body ?? {};
  res.json(
    pub(await editTheory(req.principal!.tenantId, String(req.params.id), patch, human(req), reasoning ?? '')),
  );
});
const transitionInput = z.object({ to: z.enum(THEORY_STATES), reasoning: z.string().min(1).max(20000) });
theoriesRouter.post('/theories/:id/transition', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const { to, reasoning } = transitionInput.parse(req.body);
  res.json(
    pub(await transitionTheory(req.principal!.tenantId, String(req.params.id), to, human(req), reasoning)),
  );
});
