// Research loop API (#115): settings, human steering notes, and installing the research loop harness.
import { Router } from 'express';
import { z } from 'zod';
import { collection } from '../../../packages/core/src/db.js';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  ROLE_CONNECTION_NAMES,
  addSteeringNote,
  makeResearchLoop,
  researchSettings,
  updateResearchSettings,
} from '../../../packages/core/src/researchLoop.js';
import { saveResource, type ResourcePrincipal } from './resources.js';
import { discoverTools } from '../../../packages/core/src/mcp.js';

export const researchRouter = Router();
const adminOnly = (role: string) => {
  if (role !== 'admin') throw new HttpError(403, 'Only administrators can change the research loop');
};

researchRouter.get('/research/settings', async (req, res) => {
  res.json(await researchSettings(req.principal!.tenantId));
});
researchRouter.put('/research/settings', async (req, res) => {
  adminOnly(req.principal!.user.role);
  res.json(await updateResearchSettings(req.principal!.tenantId, req.body ?? {}));
});
researchRouter.post('/research/steering', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const note = z.object({ note: z.string().min(3).max(4000) }).parse(req.body).note;
  res.json(await addSteeringNote(req.principal!.tenantId, note, req.principal!.user._id));
});

const SKILLS = {
  library: 'strategy-library',
  plugin: 'write-a-strategy-plugin',
  catalog: 'read-the-catalog',
  judge: 'judge-checklist',
} as const;
const installInput = z.object({
  name: z.string().trim().min(1).max(120).default('Research loop'),
  providers: z.object({ theorist: z.string(), judge: z.string(), coder: z.string().optional() }),
  theorists: z.number().int().min(1).max(8).optional(),
  scheduleMinutes: z.number().int().min(10).max(10080).optional(),
});
/** The three role connections (created if missing, by name) and their ids. */
export async function ensureRoleConnections(principal: ResourcePrincipal) {
  const ids = {} as Record<keyof typeof ROLE_CONNECTION_NAMES, string>;
  for (const [role, name] of Object.entries(ROLE_CONNECTION_NAMES) as [
    keyof typeof ROLE_CONNECTION_NAMES,
    string,
  ][]) {
    const found = await collection<any>('connections').findOne({ ownerId: principal.tenantId, name });
    if (found && (found.kind !== 'research' || found.role !== role))
      throw new HttpError(
        409,
        `A connection named "${name}" exists but is not the ${role} research connection`,
      );
    ids[role] =
      found?._id ??
      (await saveResource('connections', principal, { name, kind: 'research', url: '', role })).id;
    // Agents can only be given tools the connection has discovered (this also refreshes them after an upgrade).
    await discoverTools(principal.tenantId, ids[role]);
  }
  return ids;
}
/** Install (or update) the research loop harness: role connections, seed skills by name, providers by id. */
researchRouter.post('/research/loop', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const body = installInput.parse(req.body ?? {});
  const principal = req.principal! as unknown as ResourcePrincipal;
  const ownerId = principal.tenantId;
  const connections = await ensureRoleConnections(principal);
  const skills: Record<string, string | undefined> = {};
  for (const [k, name] of Object.entries(SKILLS))
    skills[k] = (await collection<any>('skills').findOne({ ownerId, name }, { projection: { _id: 1 } }))?._id;
  const s = await researchSettings(ownerId);
  const workflow = makeResearchLoop({
    name: body.name,
    providers: {
      theorist: body.providers.theorist,
      judge: body.providers.judge,
      coder: body.providers.coder ?? body.providers.theorist,
    },
    connections,
    skills,
    theorists: body.theorists ?? s.theoristsPerCycle,
    scheduleMinutes: body.scheduleMinutes,
  });
  const existing = await collection<any>('workflows').findOne(
    { ownerId, name: body.name },
    { projection: { _id: 1 } },
  );
  const saved = await saveResource('workflows', principal, workflow, existing ? { id: existing._id } : {});
  res.status(existing ? 200 : 201).json({
    harness: saved,
    connections,
    missingSkills: Object.entries(SKILLS)
      .filter(([k]) => !skills[k])
      .map(([, n]) => n),
  });
});
