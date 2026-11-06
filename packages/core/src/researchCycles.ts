// How the research loop works, and what each cycle did (#302). The harness is an ordinary workflow of agent cards;
// this joins its nodes with the models, skills, MCP connections and tools they use, and a cycle (a run of it) with
// what each agent did: its tool calls, the skills it loaded, its tokens and cost, and the theories it touched.
import { collection } from './db.js';
import { HttpError } from './security.js';
import { ROLE_CONNECTION_NAMES } from './researchLoop.js';
import { priceOf, usdOf } from './spendGuard.js';
import { theories } from './theories.js';

type Node = {
  id: string;
  name: string;
  type: string;
  next?: string;
  agentNodeIds?: string[];
  config?: {
    providerId?: string;
    skillIds?: string[];
    connections?: { connectionId: string; tools?: string[] }[];
    effort?: string;
    maxTurns?: number;
    systemPrompt?: string;
    pattern?: string;
  };
};
const roleOf = (id: string) =>
  id.startsWith('theorist')
    ? 'theorist'
    : id === 'judge_pre'
      ? 'judge (pre-code)'
      : id === 'judge_post'
        ? 'judge (post-result)'
        : id === 'coder'
          ? 'coder'
          : id;
/** What each step reads and writes, in words (the tools enforce it; see lifecycleTools). */
const DOES: Record<string, { reads: string[]; writes: string[] }> = {
  theorist: {
    reads: [
      'the research brief (focus, steering notes, recent theories)',
      'the Schema Catalog and data samples',
    ],
    writes: ['a new theory (draft → pre-review), or a revision the Judge asked for'],
  },
  'judge (pre-code)': {
    reads: ['theories in pre-review', 'the data they need'],
    writes: ['approve for code, send back to revise, or reject as untestable'],
  },
  coder: {
    reads: ['theories approved for code, sent back, or failing', 'the catalog, to check every field'],
    writes: ['a strategy plugin (tested), then one evaluation of it → post-review'],
  },
  'judge (post-result)': {
    reads: ['theories in post-review with their evaluations', 'the success gates'],
    writes: ['the verdict: successful (after the one-shot holdout) or failed; or send the code back'],
  },
};

async function researchWorkflow(ownerId: string) {
  const wf = await collection<any>('workflows').findOne({ ownerId, name: 'Research loop' });
  if (!wf) throw new HttpError(404, 'The research loop is not installed (Research → Setup → Start)');
  return wf as { _id: string; name: string; nodes: Node[]; schedule?: unknown };
}

/** The harness as a pipeline of steps, each with its model, skills, connection and tools. */
export async function researchHow(ownerId: string) {
  const wf = await researchWorkflow(ownerId);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const providerIds = new Set<string>();
  const skillIds = new Set<string>();
  const connectionIds = new Set<string>();
  for (const n of wf.nodes) {
    if (n.config?.providerId) providerIds.add(n.config.providerId);
    for (const k of n.config?.skillIds ?? []) skillIds.add(k);
    for (const c of n.config?.connections ?? []) connectionIds.add(c.connectionId);
  }
  const [providers, skills, connections] = await Promise.all([
    collection<any>('providers')
      .find({ ownerId, _id: { $in: [...providerIds] } }, { projection: { name: 1, model: 1, kind: 1 } })
      .toArray(),
    collection<any>('skills')
      .find({ ownerId, _id: { $in: [...skillIds] } }, { projection: { name: 1, description: 1 } })
      .toArray(),
    collection<any>('connections')
      .find(
        { ownerId, _id: { $in: [...connectionIds] } },
        { projection: { name: 1, role: 1, kind: 1, tools: 1 } },
      )
      .toArray(),
  ]);
  const pv = new Map(providers.map((p) => [p._id, p]));
  const sv = new Map(skills.map((s) => [s._id, s]));
  const cv = new Map(connections.map((c) => [c._id, c]));
  const agentStep = (n: Node) => {
    const role = roleOf(n.id);
    const p = pv.get(n.config?.providerId);
    return {
      id: n.id,
      name: n.name,
      role,
      model: p ? { id: p._id, name: p.name, model: p.model } : null,
      effort: n.config?.effort,
      maxTurns: n.config?.maxTurns,
      pattern: n.config?.pattern ?? 'single',
      skills: (n.config?.skillIds ?? []).map((id) => {
        const s = sv.get(id);
        return { id, name: s?.name ?? id, description: String(s?.description ?? '').slice(0, 240) };
      }),
      connections: (n.config?.connections ?? []).map((c) => {
        const conn = cv.get(c.connectionId);
        return {
          id: c.connectionId,
          name: conn?.name ?? c.connectionId,
          role: conn?.role ?? null,
          tools: c.tools ?? [],
        };
      }),
      prompt: n.config?.systemPrompt ?? '',
      ...(DOES[role] ?? { reads: [], writes: [] }),
    };
  };
  // The execution order: follow `next` from start; a parallel step expands to its agent cards.
  const steps: any[] = [];
  const seen = new Set<string>();
  let cur: Node | undefined = byId.get('start');
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === 'parallel')
      steps.push({
        id: cur.id,
        name: cur.name,
        kind: 'parallel',
        agents: (cur.agentNodeIds ?? []).map((id) => agentStep(byId.get(id)!)),
      });
    else if (cur.type === 'agent') steps.push({ kind: 'agent', ...agentStep(cur) });
    else steps.push({ id: cur.id, name: cur.name, kind: cur.type });
    cur = cur.next ? byId.get(cur.next) : undefined;
  }
  return {
    harness: { id: wf._id, name: wf.name, schedule: wf.schedule ?? null },
    connectionNames: ROLE_CONNECTION_NAMES,
    steps,
  };
}

const usdOfRun = (rows: { model: string; input: number; output: number }[]) =>
  rows.reduce((a, r) => a + usdOf(r.input, r.output, priceOf(r.model)), 0);

/** The research cycles (runs of the research harness), newest first, with cost and theory activity. */
export async function researchCycles(ownerId: string, limit = 50) {
  const wf = await researchWorkflow(ownerId);
  const runs = await collection<any>('runs')
    .find(
      { ownerId, workflowId: wf._id },
      { projection: { status: 1, createdAt: 1, finishedAt: 1, error: 1, trigger: 1 } },
    )
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  const ids = runs.map((r) => r._id);
  const usage = await collection<any>('model_usage')
    .aggregate([
      { $match: { ownerId, runId: { $in: ids } } },
      {
        $group: {
          _id: { run: '$runId', model: '$model' },
          calls: { $sum: 1 },
          input: { $sum: '$input' },
          output: { $sum: '$output' },
        },
      },
    ])
    .toArray();
  const touched = await theories()
    .aggregate<{ _id: { run: string; type: string; to?: string }; n: number }>([
      { $match: { ownerId, 'history.actor.runId': { $in: ids } } },
      { $unwind: '$history' },
      { $match: { 'history.actor.runId': { $in: ids } } },
      {
        $group: {
          _id: { run: '$history.actor.runId', type: '$history.type', to: '$history.to' },
          n: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return runs.map((r) => {
    const u = usage.filter((x) => x._id.run === r._id);
    const t = touched.filter((x) => x._id.run === r._id);
    const count = (pred: (x: (typeof t)[number]) => boolean) => t.filter(pred).reduce((a, x) => a + x.n, 0);
    return {
      id: r._id,
      status: r.status,
      trigger: r.trigger ?? null,
      startedAt: r.createdAt,
      finishedAt: r.finishedAt ?? null,
      durationMs: r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime() : null,
      ...(r.error ? { error: String(r.error).slice(0, 300) } : {}),
      calls: u.reduce((a, x) => a + x.calls, 0),
      usd:
        Math.round(usdOfRun(u.map((x) => ({ model: x._id.model, input: x.input, output: x.output }))) * 100) /
        100,
      theories: {
        proposed: count((x) => x._id.type === 'create'),
        reviewed: count(
          (x) =>
            x._id.type === 'transition' &&
            ['approved_for_code', 'revise', 'rejected_untestable'].includes(x._id.to ?? ''),
        ),
        coded: count((x) => x._id.type === 'transition' && x._id.to === 'coding'),
        evaluated: count((x) => x._id.type === 'transition' && x._id.to === 'evaluated'),
        judged: count(
          (x) =>
            x._id.type === 'transition' && ['successful', 'failed', 'revise_code'].includes(x._id.to ?? ''),
        ),
      },
    };
  });
}

/** One cycle: per agent, its tool calls, skills, tokens and cost, and the theories it touched. */
export async function researchCycle(ownerId: string, runId: string) {
  const run = await collection<any>('runs').findOne({ ownerId, _id: runId });
  if (!run) throw new HttpError(404, 'Cycle not found');
  const how = await researchHow(ownerId).catch(() => null);
  const agents = new Map<string, any>();
  // A parallel step's agents report under the step's id: one row for them all.
  for (const step of how?.steps ?? [])
    if (step.kind === 'parallel')
      agents.set(step.id, {
        id: step.id,
        name: `${step.name} (in parallel: ${step.agents.map((a: any) => a.name).join(', ')})`,
        role: 'theorist',
        model: step.agents[0]?.model ?? null,
      });
  for (const step of how?.steps ?? [])
    for (const a of step.kind === 'parallel' ? step.agents : step.kind === 'agent' ? [step] : [])
      agents.set(a.id, a);
  const usage = await collection<any>('model_usage')
    .aggregate([
      { $match: { ownerId, runId } },
      {
        $group: {
          _id: { node: '$nodeId', model: '$model' },
          calls: { $sum: 1 },
          input: { $sum: '$input' },
          output: { $sum: '$output' },
        },
      },
    ])
    .toArray();
  const byNode = new Map<string, any>();
  const node = (id: string) => {
    if (!byNode.has(id))
      byNode.set(id, {
        id,
        name: agents.get(id)?.name ?? id,
        role: agents.get(id)?.role ?? roleOf(id),
        model: agents.get(id)?.model?.model ?? null,
        status: 'not run',
        startedAt: null,
        finishedAt: null,
        skills: [] as string[],
        tools: [] as any[],
        output: '',
        calls: 0,
        input: 0,
        output_tokens: 0,
        usd: 0,
      });
    return byNode.get(id);
  };
  const open = new Map<string, any>();
  for (const e of run.events ?? []) {
    const id = e.nodeId ?? e.data?.nodeId;
    if (!id || !agents.has(id)) continue;
    const n = node(id);
    if (e.type === 'node_started') {
      n.status = 'running';
      n.startedAt = e.at ?? e.createdAt ?? null;
    } else if (e.type === 'node_completed') {
      n.status = 'completed';
      n.finishedAt = e.at ?? e.createdAt ?? null;
      n.output = String(e.data?.output ?? '').slice(0, 4000);
    } else if (e.type === 'node_failed' || e.type === 'error') {
      n.status = 'failed';
      n.output = String(e.message ?? e.data?.error ?? '').slice(0, 2000);
    } else if (e.type === 'skill_loaded') n.skills.push(e.data?.skill);
    else if (e.type === 'tool_started') {
      const call = {
        tool: e.data?.tool,
        arguments: String(e.data?.arguments ?? '').slice(0, 2000),
        at: e.at ?? null,
        result: null as string | null,
        error: false,
      };
      n.tools.push(call);
      if (e.data?.callId) open.set(`${id}:${e.data.callId}`, call);
    } else if (e.type === 'tool_completed' || e.type === 'tool_error') {
      const call = open.get(`${id}:${e.data?.callId}`);
      if (call) {
        call.result = String(e.data?.result ?? e.message ?? '').slice(0, 2000);
        call.error = e.type === 'tool_error';
      }
    }
  }
  for (const u of usage) {
    if (!u._id.node) continue;
    const n = node(u._id.node);
    n.calls += u.calls;
    n.input += u.input;
    n.output_tokens += u.output;
    n.usd += usdOf(u.input, u.output, priceOf(u._id.model));
    n.model ??= u._id.model;
  }
  const order = [...agents.keys()];
  const touched = await theories()
    .find(
      { ownerId, 'history.actor.runId': runId },
      { projection: { number: 1, title: 1, status: 1, history: 1 } },
    )
    .toArray();
  return {
    id: run._id,
    status: run.status,
    startedAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    ...(run.error ? { error: String(run.error) } : {}),
    usd: Math.round([...byNode.values()].reduce((a, n) => a + n.usd, 0) * 100) / 100,
    agents: [...byNode.values()]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((n) => ({ ...n, usd: Math.round(n.usd * 1000) / 1000 })),
    theories: touched.map((t) => ({
      ref: `T-${t.number}`,
      title: t.title,
      status: t.status,
      events: t.history
        .filter((h: any) => h.actor?.runId === runId)
        .map((h: any) => ({
          at: h.at,
          type: h.type,
          from: h.from,
          to: h.to,
          role: h.actor.role,
          node: h.actor.nodeId ?? null,
          reasoning: String(h.reasoning ?? '').slice(0, 600),
        })),
    })),
  };
}
