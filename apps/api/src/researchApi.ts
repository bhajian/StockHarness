// Research loop API (#115): settings, human steering notes, and installing the research loop harness.
import { Router } from 'express';
import { workspaceMap } from '../../../packages/core/src/workspaceMap.js';
import { researchCycle, researchCycles, researchHow } from '../../../packages/core/src/researchCycles.js';
import { createRun } from '../../../packages/core/src/runs.js';
import { z } from 'zod';
import { collection } from '../../../packages/core/src/db.js';
import { HttpError } from '../../../packages/core/src/security.js';
import {
  ROLE_CONNECTION_NAMES,
  addSteeringNote,
  makeResearchLoop,
  researchSettings,
  syncResearchSchedule,
  updateResearchSettings,
} from '../../../packages/core/src/researchLoop.js';
import { harnessScheduleOf } from '../../../packages/core/src/researchState.js';
import { budgetState, resetBudgetCache } from '../../../packages/core/src/spendGuard.js';
import { requestCancel } from '../../../packages/core/src/runs.js';
import { saveResource, type ResourcePrincipal } from './resources.js';
import {
  researchActivity,
  researchCharts,
  researchHarness,
  researchStatus,
} from '../../../packages/core/src/researchLab.js';
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
  const ownerId = req.principal!.tenantId;
  const next = await updateResearchSettings(ownerId, req.body ?? {});
  // Models, skills, the Theorists per cycle and the schedule live in the harness: rebuild it when it exists.
  const touched = [
    'agents',
    'schedule',
    'theoristsPerCycle',
    'theoristProviders',
    'agentEffort',
    'agentMaxTurns',
  ].some((k) => k in (req.body ?? {}));
  if (touched && (await researchHarness(ownerId)))
    await installResearchLoop(req.principal! as unknown as ResourcePrincipal);
  res.json(next);
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
  providers: z
    .object({ theorist: z.string().optional(), judge: z.string().optional(), coder: z.string().optional() })
    .optional(),
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
/**
 * Install (or rebuild) the research loop harness: the role connections, seed skills by name (or the skills chosen per
 * role in the research settings), providers per role, the Theorists per cycle and the schedule.
 */
export async function installResearchLoop(
  principal: ResourcePrincipal,
  o: {
    name?: string;
    providers?: { theorist?: string; judge?: string; coder?: string };
    theorists?: number;
    scheduleMinutes?: number;
  } = {},
) {
  const ownerId = principal.tenantId;
  const name = o.name ?? 'Research loop';
  // The settings are the one source of the schedule (#458): an install with an interval writes it there first.
  if (o.scheduleMinutes)
    await updateResearchSettings(ownerId, {
      schedule: {
        ...((await researchSettings(ownerId)).schedule ?? {}),
        enabled: true,
        everyMinutes: o.scheduleMinutes,
      },
    });
  const s = await researchSettings(ownerId);
  const connections = await ensureRoleConnections(principal);
  const skills: Record<string, string | undefined> = {};
  for (const [k, n] of Object.entries(SKILLS))
    skills[k] = (await collection<any>('skills').findOne({ ownerId, name: n }, { projection: { _id: 1 } }))
      ?._id;
  const fallback = (
    await collection<any>('providers').findOne(
      { ownerId, modelType: { $ne: 'embedding' } },
      { sort: { createdAt: 1 } },
    )
  )?._id;
  const provider = (role: 'theorist' | 'judge' | 'coder') =>
    o.providers?.[role] ??
    s.agents[role]?.providerId ??
    o.providers?.theorist ??
    s.agents.theorist?.providerId ??
    fallback;
  const providers = { theorist: provider('theorist'), judge: provider('judge'), coder: provider('coder') };
  if (!providers.theorist || !providers.judge || !providers.coder)
    throw new HttpError(400, 'Add a chat model first: the research agents need a model provider');
  // #413: a model per Theorist; one that was deleted falls back to the Theorist role's model.
  const known = new Set(
    (
      await collection<any>('providers')
        .find({ ownerId, _id: { $in: s.theoristProviders.filter(Boolean) } }, { projection: { _id: 1 } })
        .toArray()
    ).map((p) => String(p._id)),
  );
  const theoristProviders = s.theoristProviders.map((id) => (id && known.has(id) ? id : ''));
  const schedule = harnessScheduleOf(s);
  const workflow = makeResearchLoop({
    name,
    providers: providers as { theorist: string; judge: string; coder: string },
    theoristProviders,
    connections,
    skills,
    roleSkills: Object.fromEntries(
      (['theorist', 'judge', 'coder'] as const)
        .filter((r) => s.agents[r]?.skillIds?.length)
        .map((r) => [r, s.agents[r]!.skillIds!]),
    ),
    theorists: o.theorists ?? s.theoristsPerCycle,
    effort: s.agentEffort,
    maxTurns: s.agentMaxTurns,
    ...(schedule ? { schedule } : {}),
  });
  const existing = await collection<any>('workflows').findOne({ ownerId, name }, { projection: { _id: 1 } });
  const saved = await saveResource('workflows', principal, workflow, existing ? { id: existing._id } : {});
  // A save only sets fields: a schedule the settings no longer have is removed here.
  await syncResearchSchedule(ownerId, name);
  return {
    created: !existing,
    harness: saved,
    connections,
    missingSkills: Object.entries(SKILLS)
      .filter(([k]) => !skills[k])
      .map(([, n]) => n),
  };
}
researchRouter.post('/research/loop', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const body = installInput.parse(req.body ?? {});
  const r = await installResearchLoop(req.principal! as unknown as ResourcePrincipal, body);
  res.status(r.created ? 201 : 200).json(r);
});

// Research Lab (#116): status and KPIs, charts, the activity feed, pause / resume.
researchRouter.get('/research/status', async (req, res) => {
  res.json(await researchStatus(req.principal!.tenantId));
});
researchRouter.get('/research/charts', async (req, res) => {
  res.json(
    await researchCharts(req.principal!.tenantId, Math.min(120, Math.max(7, Number(req.query.days) || 30))),
  );
});
/** The debate as it happens: JSON for ?since=, or a Server-Sent Events stream (Accept: text/event-stream). */
researchRouter.get('/research/activity', async (req, res) => {
  const ownerId = req.principal!.tenantId;
  let since = new Date(typeof req.query.since === 'string' ? req.query.since : Date.now() - 86400_000);
  if (Number.isNaN(since.getTime())) throw new HttpError(400, 'since must be an ISO date');
  if (!String(req.headers.accept ?? '').includes('text/event-stream'))
    return void res.json(await researchActivity(ownerId, since));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  let open = true;
  req.on('close', () => (open = false));
  while (open) {
    const items = await researchActivity(ownerId, since).catch(() => []);
    for (const item of items) res.write(`event: activity\ndata: ${JSON.stringify(item)}\n\n`);
    if (items.length) since = new Date(items[items.length - 1].at);
    else res.write(': keep-alive\n\n');
    await new Promise((r) => setTimeout(r, 3000));
  }
  res.end();
});
/**
 * Pause / Resume (#458). Pause: no new cycles; a running cycle's agents stop at their next brief. Resume: refused while
 * an overall spend cap is still reached; otherwise it clears the spend-cap stop. Either way the harness schedule is
 * written from the settings.
 */
async function setPaused(req: any, paused: boolean) {
  adminOnly(req.principal!.user.role);
  const ownerId = req.principal!.tenantId;
  if (!paused) {
    resetBudgetCache(ownerId);
    const b = await budgetState(ownerId);
    if (b.exceeded)
      throw new HttpError(
        409,
        `The spend cap is still reached (${b.exceeded}). Raise the cap in Setup, then Resume.`,
      );
    const s = await researchSettings(ownerId);
    const { stoppedAt: _a, stopReason: _r, ...budget } = s.budget ?? {};
    await updateResearchSettings(ownerId, { paused: false, budget });
  } else await updateResearchSettings(ownerId, { paused: true });
  await syncResearchSchedule(ownerId);
  return researchStatus(ownerId);
}
// The workspace map (#312): data → prep → research → ideas → evaluations → simulations on one page.
researchRouter.get('/map', async (req, res) => res.json(await workspaceMap(req.principal!.tenantId)));
// How it works and what each cycle did (#302).
researchRouter.get('/research/how', async (req, res) => res.json(await researchHow(req.principal!.tenantId)));
researchRouter.get('/research/cycles', async (req, res) =>
  res.json(await researchCycles(req.principal!.tenantId, Math.min(200, Number(req.query.limit) || 50))),
);
researchRouter.get('/research/cycles/:id', async (req, res) =>
  res.json(await researchCycle(req.principal!.tenantId, String(req.params.id))),
);
researchRouter.post('/research/pause', async (req, res) => res.json(await setPaused(req, true)));
/** Run one cycle now (#301), whatever the schedule. */
researchRouter.post('/research/run-now', async (req, res) => {
  adminOnly(req.principal!.user.role);
  const ownerId = req.principal!.tenantId;
  const h = await researchHarness(ownerId);
  if (!h) throw new HttpError(409, 'Install the research loop first (Setup → Start)');
  const s = await researchSettings(ownerId);
  if (s.paused) throw new HttpError(409, 'The research loop is paused; resume it first');
  const busy = await collection<any>('runs').findOne(
    { ownerId, workflowId: h._id, status: { $in: ['queued', 'running'] } },
    { projection: { _id: 1, createdAt: 1 } },
  );
  if (busy)
    throw new HttpError(
      409,
      `A research cycle is already running (started ${new Date(busy.createdAt).toLocaleString()}); one at a time`,
    );
  const run = await createRun(
    ownerId,
    { workflowId: h._id, input: 'Research cycle (run now)', history: [] },
    {
      initiatedBy: req.principal!.user._id,
      trigger: 'studio',
    },
  );
  res.status(202).json({ id: run._id, status: run.status });
});
researchRouter.post('/research/resume', async (req, res) => res.json(await setPaused(req, false)));
/** Stop (#458): pause, and cancel the cycle that is queued or running now. */
researchRouter.post('/research/stop', async (req, res) => {
  const status = await setPaused(req, true);
  const ownerId = req.principal!.tenantId;
  const h = await researchHarness(ownerId);
  if (h) {
    const active = await collection<any>('runs')
      .find(
        { ownerId, workflowId: h._id, status: { $in: ['queued', 'running'] } },
        { projection: { _id: 1 } },
      )
      .toArray();
    for (const r of active) await requestCancel({ _id: r._id, ownerId });
    if (active.length) return void res.json(await researchStatus(ownerId));
  }
  res.json(status);
});
