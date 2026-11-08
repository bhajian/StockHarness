// The research loop (#115): Theorists → Judge (pre-code) → condition → Coder → Judge (post-result) → verdict, as
// an ordinary harness. Agents work their role's queue, read through the research connection of their role (#112),
// and learn what to do from get_research_brief: their queue, the focus, the evaluation window and the latest human
// steering note, so a note written now reaches the Theorists on the next cycle.
import { z } from 'zod';
import { collection } from './db.js';
import { agentSchema, workflowSchema, type Agent, type Workflow, type WorkflowNode } from './schema.js';
import { evaluations, evaluatorSettings, latestPriceDate } from './evaluations.js';
import { strategyPluginVersions, strategyPlugins } from './strategyPlugins.js';
import { activeGates } from './gates.js';
import { theories, type Theory } from './theories.js';
import type { ResearchRole } from './lifecycleTools.js';

/** The small-scale default (owner, 2026-11-05): 50 large caps; wider scopes come later. */
export const DEFAULT_SYMBOLS =
  'AAPL MSFT NVDA AMZN GOOGL META AVGO TSLA JPM LLY V UNH XOM MA JNJ PG HD COST ABBV MRK CVX KO PEP ADBE CRM WMT BAC NFLX AMD TMO ORCL ACN MCD CSCO ABT LIN DHR WFC TXN DIS PM INTU VZ CAT AMGN IBM QCOM GE NOW'.split(
    ' ',
  );
export const researchSettingsSchema = z.object({
  /** What the Theorists should look into (shown in every brief). */
  focus: z.string().max(4000).default(''),
  /** Theorists that propose in parallel each cycle (the harness's Parallel step). */
  theoristsPerCycle: z.number().int().min(1).max(8).default(2),
  /** #336: at this many ideas waiting for code, the Theorists stop proposing new ones (revisions still go). */
  maxCoderBacklog: z.number().int().min(1).max(200).default(8),
  /** The evaluation scope the Coder uses: symbols and how many years before the holdout. */
  evaluationSymbols: z.array(z.string().min(1).max(20)).max(2000).default(DEFAULT_SYMBOLS),
  /**
   * The evaluation scope (#300): the symbols above, or the N largest names by market cap on each date (point in
   * time; N = 500 is the S&P 500 proxy, since the FMP plan has no constituents list).
   */
  scope: z
    .object({
      kind: z.enum(['symbols', 'top_market_cap']).default('symbols'),
      top: z.number().int().min(1).max(5000).default(500),
    })
    .default({}),
  evaluationYears: z.number().int().min(1).max(15).default(3),
  /** Effort and turns per research agent (#266): the defaults suit real runs; a dev smoke test uses medium / ~12. */
  agentEffort: z.enum(['light', 'medium', 'high', 'extra-high', 'max']).default('high'),
  agentMaxTurns: z.number().int().min(3).max(200).default(30),
  /** Paused: no scheduled cycles, and agents of a running cycle are told to stop (#116). */
  paused: z.boolean().default(false),
  /**
   * Spend (#297). dailyTokenAlert only alerts; capUsd (since capSince) and dailyCapUsd (the UTC day) stop every model
   * call in the workspace when reached and pause the loop. prices override the built-in table (USD per 1M tokens).
   */
  budget: z
    .object({
      dailyTokenAlert: z.number().int().min(0).optional(),
      usdPerMillionTokens: z.number().min(0).optional(),
      capUsd: z.number().min(0).optional(),
      capSince: z.coerce.date().optional(),
      dailyCapUsd: z.number().min(0).optional(),
      prices: z.record(z.object({ input: z.number().min(0), output: z.number().min(0) })).optional(),
      /** Per-model caps (#301), on top of the overall ones: only that model's calls are refused at its cap. */
      models: z
        .record(z.object({ capUsd: z.number().min(0).optional(), dailyCapUsd: z.number().min(0).optional() }))
        .optional(),
      stoppedAt: z.coerce.date().optional(),
      stopReason: z.string().optional(),
    })
    .default({}),
  /** Model and skills per role (provider ids, skill ids); the harness is rebuilt when they change. */
  agents: z
    .object({
      theorist: z.object({ providerId: z.string(), skillIds: z.array(z.string()).optional() }).optional(),
      judge: z.object({ providerId: z.string(), skillIds: z.array(z.string()).optional() }).optional(),
      coder: z.object({ providerId: z.string(), skillIds: z.array(z.string()).optional() }).optional(),
    })
    .default({}),
  /** Cycles every N minutes (applied to the harness schedule). */
  schedule: z
    .object({
      enabled: z.boolean(),
      everyMinutes: z.number().int().min(10).max(10080),
      /** Stop scheduling after this moment (ISO date-time), #301. */
      until: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),
});
export type ResearchSettings = z.infer<typeof researchSettingsSchema> & {
  steering?: { note: string; at: Date; by?: string }[];
};
const settings = () =>
  collection<{ _id: string } & Partial<ResearchSettings> & Record<string, unknown>>('research_settings');

export async function researchSettings(ownerId: string): Promise<ResearchSettings> {
  const s = await settings().findOne({ _id: ownerId });
  const { _id, steering, ...rest } = s ?? ({ _id: ownerId } as Record<string, unknown>);
  return {
    ...researchSettingsSchema.parse(pick(rest)),
    ...(steering ? { steering: steering as ResearchSettings['steering'] } : {}),
  };
}
const pick = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k in researchSettingsSchema.shape));
export async function updateResearchSettings(ownerId: string, patch: unknown) {
  const next = researchSettingsSchema.partial().parse(patch);
  await settings().updateOne({ _id: ownerId }, { $set: next }, { upsert: true });
  return researchSettings(ownerId);
}
/** A human steering note: the Theorists see it in their next brief (the latest five are kept). */
export async function addSteeringNote(ownerId: string, note: string, by?: string) {
  const text = note.trim();
  if (text.length < 3) throw new Error('Write the steering note');
  await settings().updateOne(
    { _id: ownerId },
    {
      $push: {
        steering: {
          $each: [{ note: text.slice(0, 4000), at: new Date(), ...(by ? { by } : {}) }],
          $slice: -5,
        },
      },
    } as Record<string, unknown>,
    { upsert: true },
  );
  return researchSettings(ownerId);
}

const addYears = (iso: string, n: number) => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;
/** The evaluation window the Coder should use: the years before the holdout, on the configured symbols. */
export async function evaluationParams(ownerId: string, s?: ResearchSettings) {
  const st = s ?? (await researchSettings(ownerId));
  const end = (await evaluatorSettings(ownerId)).readableEnd ?? (await latestPriceDate(ownerId));
  if (!end) return undefined;
  const start = addYears(end, -st.evaluationYears);
  return st.scope?.kind === 'top_market_cap'
    ? { start, end, universe: { top_by_market_cap: st.scope.top } }
    : { start, end, symbols: st.evaluationSymbols };
}

const QUEUES: Record<ResearchRole | 'judge_post', Theory['status'][]> = {
  theorist: ['revise'],
  judge: ['pre_review', 'post_review'],
  judge_post: ['post_review'],
  coder: ['approved_for_code', 'revise_code', 'code_error', 'coding'],
};
const line = (t: Theory) => ({
  theory_id: `T-${t.number}`,
  title: t.title,
  status: t.status,
  family: t.family,
  ...(t.claim ? { claimed_by: t.claim.by } : {}),
  // A theory sent back: what to change, from the Judge or a person (#122).
  ...(t.status === 'revise' || t.status === 'revise_code' ? { feedback: sentBack(t) } : {}),
});
const sentBack = (t: Theory) => {
  const h = [...(t.history ?? [])].reverse().find((x) => x.type === 'transition' && x.to === t.status);
  return h ? { by: h.actor.role, reasoning: h.reasoning.slice(0, 2000) } : undefined;
};

/**
 * What the Coder does next with a queued theory (#280). A theory left in coding by an earlier cycle may already have
 * passing code; without this the Coder would start it over and run out of turns before evaluating it.
 */
export type CoderStep = 'evaluate' | 'wait' | 'fix' | 'revise' | 'write' | 'done';
export async function coderStep(
  t: Theory,
): Promise<{ next_step: CoderStep; instruction: string; [k: string]: unknown }> {
  const ref = `T-${t.number}`;
  if (t.status === 'revise_code')
    return {
      next_step: 'revise',
      instruction: `Change the code exactly as the feedback says, then submit_code(theory_id="${ref}") and evaluate_strategy once it passes.`,
    };
  if (t.status === 'code_error') {
    const err = [...(t.history ?? [])].reverse().find((h) => h.to === 'code_error');
    return {
      next_step: 'fix',
      last_error: err?.reasoning.slice(0, 1500) ?? 'unknown',
      instruction: `Fix only what the error points at and call submit_code(theory_id="${ref}") again; evaluate_strategy once it passes.`,
    };
  }
  if (t.status === 'coding' && t.plugin?.name) {
    const p = await strategyPlugins().findOne({ ownerId: t.ownerId, name: t.plugin.name });
    const latest = p
      ? await strategyPluginVersions()
          .find({ ownerId: t.ownerId, pluginId: p._id })
          .sort({ version: -1 })
          .limit(1)
          .next()
      : null;
    if (latest) {
      const evals = await evaluations()
        .find(
          { ownerId: t.ownerId, theoryId: t._id, pluginVersion: latest.version },
          { projection: { status: 1 } },
        )
        .toArray();
      if (evals.some((e) => e.status === 'running'))
        return {
          next_step: 'wait',
          plugin_version: latest.version,
          instruction: 'An evaluation is running; skip this theory.',
        };
      // Forward-only theories are never backtested: with passing code they wait for paper tracking (Layer 5).
      if (latest.tested === 'passed' && t.forwardOnly)
        return {
          next_step: 'done',
          plugin_version: latest.version,
          instruction: 'Forward only: nothing to do.',
        };
      if (latest.tested === 'passed' && !evals.some((e) => e.status === 'succeeded'))
        return {
          next_step: 'evaluate',
          plugin_version: latest.version,
          instruction: `v${latest.version} already passed its test. Call evaluate_strategy(theory_id="${ref}", params=evaluation_params) now; do not rewrite the code or re-read the data.`,
        };
    }
  }
  return {
    next_step: 'write',
    instruction: `get_theory("${ref}"), describe each collection it needs once, write the plugin and call submit_code; then evaluate_strategy once it passes.`,
  };
}
const STEP_ORDER: Record<CoderStep, number> = { evaluate: 0, fix: 1, revise: 2, write: 3, wait: 4, done: 5 };

/** The queue lines; the Coder's carry the next step, ready-to-evaluate theories first. */
async function coderQueue(queue: Theory[], role: ResearchRole | undefined) {
  if (role !== 'coder') return queue.map(line);
  const lines = await Promise.all(queue.map(async (t) => ({ ...line(t), ...(await coderStep(t)) })));
  return lines
    .filter((l) => l.next_step !== 'done')
    .sort((a, b) => STEP_ORDER[a.next_step] - STEP_ORDER[b.next_step]);
}
/** get_research_brief: what this role should do now. */
export async function researchBrief(
  ownerId: string,
  role: ResearchRole | undefined,
  meta: { agentId?: string; nodeId?: string } = {},
) {
  const s = await researchSettings(ownerId);
  const counts = Object.fromEntries(
    (
      await theories()
        .aggregate<{ _id: string; n: number }>([
          { $match: { ownerId } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ])
        .toArray()
    ).map((c) => [c._id, c.n]),
  );
  const queue = role
    ? await theories()
        .find({ ownerId, status: { $in: QUEUES[role] } })
        .sort({ number: 1 })
        .limit(50)
        .toArray()
    : [];
  const me = meta.agentId ?? meta.nodeId;
  const recent = await theories()
    .find({ ownerId }, { projection: { number: 1, title: 1, status: 1, family: 1 } })
    .sort({ number: -1 })
    .limit(20)
    .toArray();
  const gates = await activeGates(ownerId);
  if (s.paused)
    return {
      role: role ?? 'none',
      paused: true,
      instruction: 'The research loop is paused: do nothing and reply DONE.',
    };
  const coderQueueSize = await coderBacklog(ownerId);
  const backlogFull = coderQueueSize >= s.maxCoderBacklog;
  return {
    role: role ?? 'none',
    ...(role === 'theorist' && backlogFull
      ? {
          backlog_full: true,
          instruction: `The Coder has ${coderQueueSize} ideas waiting for code (the limit is ${s.maxCoderBacklog}): do not propose a new theory this cycle. If your queue has a theory sent back for revision, revise it; otherwise reply DONE.`,
        }
      : {}),
    focus: s.focus || 'none set: any family from the strategy-library skill',
    steering: (s.steering ?? []).slice(-3).map((n) => ({ note: n.note, at: n.at })),
    counts,
    queue: await coderQueue(
      queue.filter((t) => role !== 'coder' || !t.claim || t.claim.by === me || stale(t.claim.at)),
      role,
    ),
    recent_theories: recent.map((t) => ({
      theory_id: `T-${t.number}`,
      title: t.title,
      status: t.status,
      family: t.family,
    })),
    // The Coder's real queue size, whatever the role asking (#273).
    coder_queue: coderQueueSize,
    coder_backlog_limit: s.maxCoderBacklog,
    evaluation_params: await evaluationParams(ownerId, s),
    gates: { version: gates.version, ...gates.gates },
  };
}
/** Ideas waiting for the Coder (#336). */
export const coderBacklog = (ownerId: string) =>
  theories().countDocuments({ ownerId, status: { $in: QUEUES.coder } });
export const CLAIM_HOURS = 2;
export const stale = (at: Date) => Date.now() - new Date(at).getTime() > CLAIM_HOURS * 3600_000;

// --- the harness ----------------------------------------------------------------------------------------------
export const ROLE_CONNECTION_NAMES: Record<ResearchRole, string> = {
  theorist: 'Research — Theorist',
  judge: 'Research — Judge',
  coder: 'Research — Coder',
};
const DATA_TOOLS = ['list_collections', 'describe_collection', 'sample_collection', 'query_collection'];
export const ROLE_TOOLS: Record<'theorist' | 'judge_pre' | 'coder' | 'judge_post', string[]> = {
  theorist: ['get_research_brief', 'search_theories', 'get_theory', 'submit_theory', ...DATA_TOOLS],
  judge_pre: [
    'get_research_brief',
    'search_theories',
    'get_theory',
    'review_theory',
    'describe_collection',
    'sample_collection',
  ],
  coder: [
    'get_research_brief',
    'get_theory',
    'submit_code',
    'evaluate_strategy',
    'get_evaluation',
    'describe_collection',
    'sample_collection',
    'query_collection',
  ],
  judge_post: ['get_research_brief', 'get_theory', 'get_evaluation', 'set_verdict'],
};
export const LOOP_DONE = 'NOTHING_TO_CODE';
const PROMPTS = {
  theorist: (i: number, n: number) =>
    `You are Theorist ${i} of ${n} in the StockHarness research loop. Propose ONE new, testable theory.\n` +
    '1. Call get_research_brief: read the focus, the human steering notes (follow them), recent theories and your queue. If it has an instruction, follow it first.\n' +
    '2. If your queue has a theory sent back for revision, fix exactly what the Judge asked and re-submit it with submit_theory(theory_id=...). Otherwise propose a new one.\n' +
    `3. Pick an idea from the strategy-library skill; Theorist ${i} prefers the family at position ${i} of the library order, so parallel Theorists differ. Combine, condition or refine it; never resubmit a card unchanged.\n` +
    '4. Check search_theories for near-duplicates, and describe_collection for every field you rely on (exact names, known-at rule).\n' +
    '5. Call submit_theory with a precise hypothesis, the signal logic in words, data_needed (collection.field), horizon_days, direction and a measurable falsification. Reply with the theory id.',
  judge_pre:
    'You are the Judge (pre-code review) in the StockHarness research loop. Follow the judge-checklist skill.\n' +
    'Call get_research_brief, then for every theory in your queue with status pre_review: get_theory, check testability, lookahead, novelty, plausibility and data, and call review_theory (approve, revise with exactly what to change, or reject). Leave post_review theories for the post-result review.\n' +
    'End with a one-line summary of your decisions.',
  coder:
    'You are the Coder in the StockHarness research loop. Follow the write-a-strategy-plugin skill.\n' +
    'Call get_research_brief. Your queue holds every theory that needs code, in the order to work on them; each item has a next_step and an instruction. If the queue is empty, reply DONE at once.\n' +
    "Do each item's next_step, one theory at a time, finishing it before the next:\n" +
    '- evaluate: the code already passed its test. Call evaluate_strategy(theory_id, params) right away with the evaluation_params from the brief. Do not rewrite the code or read the data again.\n' +
    '- write: get_theory, describe each collection it needs once (never twice), write the plugin and call submit_code(theory_id, code).\n' +
    '- fix / revise: change only what the last_error or the feedback points at and call submit_code again.\n' +
    '- wait: an evaluation is running; skip it.\n' +
    'After submit_code passes, call evaluate_strategy(theory_id, params) once, with the evaluation_params from the brief.\n' +
    'Never tune the code to the metrics. When no theory is left in your queue, reply DONE.',
  judge_post:
    'You are the Judge (post-result review) in the StockHarness research loop. Follow the judge-checklist skill.\n' +
    'Call get_research_brief. For every theory in post_review: get_theory (its evaluations), then set_verdict. The gates decide: request successful only if you believe they pass (a passing exploration runs the one-shot holdout); request failed with reasons otherwise, or revise with one concrete change. Cite the numbers. Reply with a one-line summary per theory.',
};

export type ResearchLoopInput = {
  name?: string;
  providers: { theorist: string; judge: string; coder: string };
  connections: Record<ResearchRole, string>;
  skills: { library?: string; plugin?: string; catalog?: string; judge?: string };
  /** Skills per role chosen in the research settings (replace the seed skills for that role). */
  roleSkills?: Partial<Record<ResearchRole, string[]>>;
  theorists: number;
  effort?: 'light' | 'medium' | 'high' | 'extra-high' | 'max';
  maxTurns?: number;
  scheduleMinutes?: number;
  scheduleUntil?: string;
};
/** The research loop harness (ids resolved). */
export function makeResearchLoop(o: ResearchLoopInput): Workflow {
  const sk = (...ids: (string | undefined)[]) => ids.filter(Boolean) as string[];
  const skillsFor = (role: ResearchRole, ...defaults: (string | undefined)[]) =>
    o.roleSkills?.[role]?.length ? o.roleSkills[role]! : sk(...defaults);
  const agent = (
    name: string,
    providerId: string,
    systemPrompt: string,
    connectionId: string,
    tools: string[],
    skillIds: string[],
    extra: Partial<Agent> = {},
  ) =>
    agentSchema.parse({
      name,
      providerId,
      systemPrompt,
      connections: [{ connectionId, tools }],
      skillIds,
      maxTurns: o.maxTurns ?? 30,
      timeoutSeconds: 1800,
      // No token budget (#263): the research loop is bounded by the per-theory caps the tools enforce, and watched
      // by the Research Lab's budget alerts; the effort preset's budget stopped Theorists before they submitted.
      tokenBudget: 0,
      effort: o.effort ?? 'high',
      ...extra,
    });
  const nodes: WorkflowNode[] = [
    { id: 'start', name: 'Start', type: 'start', next: 'theorists', position: { x: 40, y: 200 } },
  ];
  const theoristIds = Array.from({ length: o.theorists }, (_, i) => `theorist_${i + 1}`);
  theoristIds.forEach((id, i) =>
    nodes.push({
      id,
      name: `Theorist ${i + 1}`,
      type: 'agent',
      config: agent(
        `Theorist ${i + 1}`,
        o.providers.theorist,
        PROMPTS.theorist(i + 1, o.theorists),
        o.connections.theorist,
        ROLE_TOOLS.theorist,
        skillsFor('theorist', o.skills.library, o.skills.catalog),
      ),
      prompt: 'Research cycle: {{input}}',
      next: 'judge_pre',
      position: { x: 260, y: 40 + i * 140 },
    } as WorkflowNode),
  );
  nodes.push(
    {
      id: 'theorists',
      name: 'Theorists',
      type: 'parallel',
      agentNodeIds: theoristIds,
      agentIds: [],
      prompt: 'Research cycle: {{input}}',
      next: 'judge_pre',
      position: { x: 180, y: 200 },
    } as WorkflowNode,
    {
      id: 'judge_pre',
      name: 'Judge (pre-code)',
      type: 'agent',
      config: agent(
        'Judge (pre-code)',
        o.providers.judge,
        PROMPTS.judge_pre,
        o.connections.judge,
        ROLE_TOOLS.judge_pre,
        skillsFor('judge', o.skills.judge, o.skills.catalog, o.skills.library),
      ),
      prompt: 'Review the theories submitted this cycle.\n\nTheorists said:\n{{last}}',
      // The Coder always runs: with an empty queue it replies DONE at once (#273), so no theory left in coding
      // is skipped because of how the Judge worded its reply.
      next: 'coder',
      position: { x: 520, y: 200 },
    } as WorkflowNode,
    {
      id: 'coder',
      name: 'Coder',
      type: 'agent',
      config: agent(
        'Coder',
        o.providers.coder,
        PROMPTS.coder,
        o.connections.coder,
        ROLE_TOOLS.coder,
        skillsFor('coder', o.skills.plugin, o.skills.catalog),
        {
          pattern: 'loop',
          patternConfig: { reflections: 1, iterations: 4, doneMarker: 'DONE', maxPlanSteps: 5 },
        },
      ),
      prompt: 'Code and evaluate the approved theories.',
      next: 'judge_post',
      position: { x: 960, y: 120 },
    } as WorkflowNode,
    {
      id: 'judge_post',
      name: 'Judge (post-result)',
      type: 'agent',
      config: agent(
        'Judge (post-result)',
        o.providers.judge,
        PROMPTS.judge_post,
        o.connections.judge,
        ROLE_TOOLS.judge_post,
        skillsFor('judge', o.skills.judge, o.skills.library),
      ),
      prompt: 'Give verdicts for the evaluated theories.',
      next: 'finish',
      position: { x: 1180, y: 200 },
    } as WorkflowNode,
    {
      id: 'finish',
      name: 'Finish',
      type: 'finish',
      template: '{{last}}',
      position: { x: 1400, y: 200 },
    } as WorkflowNode,
  );
  return workflowSchema.parse({
    name: o.name ?? 'Research loop',
    description:
      'Layer 4 research loop: parallel Theorists propose, the Judge reviews, the Coder writes and evaluates plugins, the Judge gives mechanical verdicts. Steer it from the research settings.',
    enabled: true,
    startAt: 'start',
    maxSteps: 200,
    resumePolicy: 'safe',
    resources: [],
    bindings: [],
    nodes,
    ...(o.scheduleMinutes
      ? {
          schedule: {
            enabled: true,
            everyMinutes: o.scheduleMinutes,
            input: 'Scheduled research cycle',
            ...(o.scheduleUntil ? { until: o.scheduleUntil } : {}),
          },
        }
      : {}),
  });
}
