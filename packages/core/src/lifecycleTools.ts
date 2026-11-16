// Lifecycle MCP tools (#112), served on the research connection. The connection's role decides what its agent
// may do (the Judge reviews and gives verdicts, the Coder submits code, the Theorist submits theories); every write
// is a legal transition of the state machine (#110) with its reasoning. Read tools are open to every role.
import { HttpError } from './security.js';
import { OPTIONS_EVALUATOR_READY, STRUCTURE_IDS } from './profiles.js';
import {
  createTheory,
  editTheory,
  getTheory,
  lifecycleCaps,
  linkTheory,
  transitionTheory,
  type Theory,
  type TheoryActor,
} from './theories.js';
import { searchTheories } from './theoryMemory.js';
import { evaluations, getEvaluation, startEvaluation, type Evaluation } from './evaluations.js';
import { agentSummary, testStrategy } from './strategyTools.js';
import type { TheoryRole } from './theoryLifecycle.js';
import {
  activeGates,
  allGatesPass,
  evaluateGates,
  exploreGatesPass,
  lockGates,
  outcomeOf,
  verdictProblem,
} from './gates.js';
import { startHoldoutEvaluation } from './evaluations.js';

export type ResearchRole = 'theorist' | 'judge' | 'coder';
type Meta = { agentId?: string; runId?: string; model?: string; nodeId?: string };
const WAIT_MAX_SECONDS = 50;

const str = { type: 'string' } as const;
const THEORY_FIELDS = {
  title: str,
  hypothesis: str,
  rationale: str,
  data_needed: { type: 'array', items: str, description: 'Catalog collections and fields the test needs' },
  universe: str,
  signal_logic: { type: 'string', description: 'The signal in words: what is ranked, how, and when' },
  horizon_days: { type: 'integer', minimum: 1 },
  direction: {
    type: 'string',
    enum: ['long', 'short', 'long_short', 'neutral'],
    description: 'neutral is for options ideas (straddles, strangles, iron condors)',
  },
  instrument: {
    type: 'string',
    enum: ['equity', 'options'],
    description: "The idea's profile (#323): equity (default) or options; see profiles in the brief",
  },
  structure: {
    type: 'string',
    enum: STRUCTURE_IDS,
    description: 'For an options idea: the structure (covered_call, cash_secured_put, iron_condor, ...)',
  },
  falsification: { type: 'string', description: 'What result would show the hypothesis is wrong' },
  family: str,
  tags: { type: 'array', items: str },
  differs_from: { type: 'string', description: 'For an idea close to an earlier theory: what is different' },
};

export const LIFECYCLE_TOOLS: {
  name: string;
  roles: ResearchRole[] | 'all';
  description: string;
  inputSchema: Record<string, unknown>;
}[] = [
  {
    name: 'get_research_brief',
    roles: 'all',
    description:
      "Start here every cycle: your role's queue of theories, the research focus, the latest human steering notes, recent theories, the evaluation window to use and the active gates.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  // #459: the research vault, navigated a step at a time.
  {
    name: 'vault_index',
    roles: 'all',
    description:
      'The research vault: linked notes on every past idea, each strategy family (its yield, lessons, best and worst ideas) and the gates ideas fail. Start here, then vault_read a family note before proposing in it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vault_search',
    roles: 'all',
    description:
      'Vault notes that mention every word of a text (ideas, families, lessons), best first, with a snippet.',
    inputSchema: {
      type: 'object',
      properties: { text: str, limit: { type: 'integer', minimum: 1, maximum: 30 } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'vault_read',
    roles: 'all',
    description:
      'One vault note by path (index, families/<family>, ideas/T-<n>, lessons/gates), or one of its ## sections (e.g. Lessons, Post-mortem). Follow its [[links]].',
    inputSchema: {
      type: 'object',
      properties: { path: str, section: str },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'vault_scratch',
    roles: ['theorist'],
    description:
      'Write a short scratch note (your plan: candidate hypotheses, why and why not, [[ideas/T-n]] links). Returns its path; vault_read reads it back, and the Judge can read it.',
    inputSchema: {
      type: 'object',
      properties: { title: str, text: str },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'vault_backlinks',
    roles: 'all',
    description:
      'The vault notes that link to a note (e.g. every idea in a family links to its family note).',
    inputSchema: {
      type: 'object',
      properties: { path: str },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_theories',
    roles: 'all',
    description:
      'Theories closest to a text (any status, failed ones included), with their similarity. Check before proposing an idea.',
    inputSchema: {
      type: 'object',
      properties: { text: str, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_theory',
    roles: 'all',
    description:
      'One theory (T-<n> or id): content, status, revision and code-attempt counts, plugin versions, evaluation summaries and the recent debate.',
    inputSchema: {
      type: 'object',
      properties: { theory_id: str },
      required: ['theory_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_theory',
    roles: ['theorist'],
    description:
      'Propose a new theory for review, or re-submit one the Judge sent back for revision (pass theory_id and the changed fields). A near-duplicate of an earlier theory is refused unless differs_from says what is different.',
    inputSchema: {
      type: 'object',
      properties: { theory_id: str, reasoning: str, ...THEORY_FIELDS },
      required: ['reasoning'],
      additionalProperties: false,
    },
  },
  {
    name: 'refine_theory',
    roles: ['theorist'],
    description:
      'Refine a near miss from the brief (#528): a new theory that keeps what worked in its parent and changes one thing aimed at the gate it failed. Give the full theory fields, plus change (exactly what differs from the parent) and why (why that fixes its failing gate, an economic reason, not a nudged threshold). It is a new trial; a lineage stops at 3 generations and 2 holdout runs.',
    inputSchema: {
      type: 'object',
      properties: { parent_id: str, change: str, why: str, reasoning: str, ...THEORY_FIELDS },
      required: [
        'parent_id',
        'change',
        'why',
        'reasoning',
        'title',
        'hypothesis',
        'signal_logic',
        'falsification',
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'review_theory',
    roles: ['judge'],
    description:
      'Pre-code review of a theory in pre_review: approve (testable, plausible, novel), revise (say exactly what to change) or reject (untestable). Revisions are capped per theory.',
    inputSchema: {
      type: 'object',
      properties: {
        theory_id: str,
        decision: { type: 'string', enum: ['approve', 'revise', 'reject'] },
        reasoning: str,
      },
      required: ['theory_id', 'decision', 'reasoning'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_code',
    roles: ['coder'],
    description:
      'Save the strategy plugin for an approved theory as a new version and dry-run it (test_strategy). Returns the error with line numbers or a passing summary, and the fix attempts left. When it passes, call evaluate_strategy with the theory_id. After the last attempt the theory goes to the Judge.',
    inputSchema: {
      type: 'object',
      properties: { theory_id: str, code: str, note: str },
      required: ['theory_id', 'code'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_verdict',
    roles: ['judge'],
    description:
      'Post-result review of a theory in post_review: successful, failed, or revise (send it back to the Coder with what to change). Give the reasoning, citing the evaluation numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        theory_id: str,
        verdict: { type: 'string', enum: ['successful', 'failed', 'revise'] },
        reasoning: str,
      },
      required: ['theory_id', 'verdict', 'reasoning'],
      additionalProperties: false,
    },
  },
];
export const isLifecycleTool = (name: string) => LIFECYCLE_TOOLS.some((t) => t.name === name);
/** The lifecycle tools a role is offered. */
export const lifecycleToolsFor = (role?: ResearchRole) =>
  LIFECYCLE_TOOLS.filter((t) => t.roles === 'all' || (role && t.roles.includes(role))).map(
    ({ roles: _r, ...def }) => def,
  );

const actorOf = (role: TheoryRole, meta: Meta): TheoryActor => ({
  role,
  ...(meta.agentId ? { agentId: meta.agentId } : {}),
  ...(meta.runId ? { runId: meta.runId } : {}),
  ...(meta.model ? { model: meta.model } : {}),
  ...(meta.nodeId ? { nodeId: meta.nodeId } : {}),
});
const need = (role: ResearchRole | undefined, allowed: ResearchRole[], tool: string) => {
  if (!role || !allowed.includes(role))
    throw new HttpError(
      403,
      `${tool} is for the ${allowed.join(' or ')}; this connection acts as ${role ?? 'no research role'}`,
    );
};
const content = (a: Record<string, any>) =>
  Object.fromEntries(
    Object.entries({
      title: a.title,
      hypothesis: a.hypothesis,
      rationale: a.rationale,
      dataNeeded: a.data_needed,
      universe: a.universe,
      signalLogic: a.signal_logic,
      horizonDays: a.horizon_days,
      direction: a.direction,
      instrument: a.instrument,
      structure: a.structure,
      falsification: a.falsification,
      family: a.family,
      tags: a.tags,
      differsFrom: a.differs_from,
    }).filter(([, v]) => v !== undefined),
  );
const brief = (t: Theory) => ({
  theory_id: `T-${t.number}`,
  status: t.status,
  revisions: t.revisions,
  code_attempts: t.codeAttempts,
  ...(t.plugin ? { plugin: t.plugin } : {}),
});
const slug = (t: Theory) =>
  `t${t.number}_${t.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`.slice(0, 60);

async function theoryView(ownerId: string, t: Theory) {
  const evals = await Promise.all(
    t.evaluationIds.slice(-5).map((id) =>
      getEvaluation(ownerId, id)
        .then((e) => agentSummary(e))
        .catch(() => ({ evaluation_id: id, status: 'missing' })),
    ),
  );
  // #528: a refinement shows its parent's signal and the gates it failed, for the Judge to compare.
  let refines: Record<string, unknown> | undefined;
  if (t.parent) {
    const p = await getTheory(ownerId, t.parent).catch(() => undefined);
    const { lastVerdict } = await import('./learning.js');
    const v = p ? lastVerdict(p) : undefined;
    refines = {
      parent: t.parent,
      lineage: t.lineage,
      generation: t.generation,
      change: t.refinement?.change,
      why: t.refinement?.why,
      ...(p
        ? {
            parent_title: p.title,
            parent_signal_logic: p.signalLogic,
            parent_status: p.status,
            parent_failing_gates: (v?.gates ?? [])
              .filter((r) => !r.passed && !r.gate.startsWith('holdout'))
              .map((r) => ({ gate: r.gate, value: r.value, threshold: r.threshold })),
            parent_cause: (v?.data?.cause as any)?.text,
          }
        : {}),
    };
  }
  return {
    ...brief(t),
    ...(refines ? { refines } : {}),
    title: t.title,
    hypothesis: t.hypothesis,
    rationale: t.rationale,
    data_needed: t.dataNeeded,
    universe: t.universe,
    signal_logic: t.signalLogic,
    horizon_days: t.horizonDays,
    direction: t.direction,
    falsification: t.falsification,
    family: t.family,
    tags: t.tags,
    ...(t.differsFrom ? { differs_from: t.differsFrom } : {}),
    trials: t.trials,
    evaluations: evals,
    debate: t.history.slice(-20).map((h) => ({
      at: h.at,
      type: h.type,
      ...(h.from ? { from: h.from } : {}),
      ...(h.to ? { to: h.to } : {}),
      by: h.actor.role,
      reasoning: h.reasoning.slice(0, 1500),
    })),
  };
}

export async function callLifecycleTool(
  ownerId: string,
  role: ResearchRole | undefined,
  name: string,
  args: Record<string, any>,
  meta: Meta = {},
) {
  switch (name) {
    case 'get_research_brief': {
      const { researchBrief } = await import('./researchLoop.js');
      return researchBrief(ownerId, role, meta);
    }
    case 'vault_scratch':
    case 'vault_index':
    case 'vault_search':
    case 'vault_read':
    case 'vault_backlinks': {
      const { vaultTool } = await import('./vault.js');
      return vaultTool(ownerId, name, args, meta);
    }
    case 'search_theories':
      return searchTheories(ownerId, String(args.text ?? ''), Math.min(50, Number(args.limit) || 10));
    case 'get_theory':
      return theoryView(ownerId, await getTheory(ownerId, String(args.theory_id ?? '')));
    case 'submit_theory': {
      need(role, ['theorist'], name);
      const actor = actorOf('theorist', meta);
      if (args.instrument === 'options' && !OPTIONS_EVALUATOR_READY)
        throw new HttpError(
          409,
          'Options ideas cannot be tested yet: the options evaluator is coming (#329). Propose an equity idea (instrument: equity) this cycle.',
        );
      if (args.theory_id) {
        const t = await getTheory(ownerId, String(args.theory_id));
        const edited = await editTheory(ownerId, t._id, content(args), actor, args.reasoning);
        return brief(await transitionTheory(ownerId, edited._id, 'pre_review', actor, args.reasoning));
      }
      await assertBacklogRoom(ownerId);
      // #462: the Theorist mode that produced the idea, for the scorecards (mode:single / mode:steps).
      const { researchSettings } = await import('./researchLoop.js');
      const mode = (await researchSettings(ownerId)).theoristMode ?? 'single';
      const c = content(args) as Record<string, any>;
      c.tags = [...new Set([...(Array.isArray(c.tags) ? c.tags : []), `mode:${mode}`])];
      return brief(await createTheory(ownerId, c as any, actor, { submit: true, reasoning: args.reasoning }));
    }
    case 'refine_theory': {
      need(role, ['theorist'], name);
      const actor = actorOf('theorist', meta);
      const parent = await getTheory(ownerId, String(args.parent_id ?? ''));
      const { lineageCheck } = await import('./learning.js');
      const { root, generation } = await lineageCheck(ownerId, parent);
      await assertBacklogRoom(ownerId);
      const { researchSettings } = await import('./researchLoop.js');
      const mode = (await researchSettings(ownerId)).theoristMode ?? 'single';
      const c = content(args) as Record<string, any>;
      const pref = `T-${parent.number}`;
      Object.assign(c, {
        family: c.family ?? parent.family,
        parent: pref,
        lineage: root,
        generation,
        refinement: { change: String(args.change ?? ''), why: String(args.why ?? '') },
        differsFrom: c.differsFrom ?? `Refines ${pref}: ${String(args.change ?? '').slice(0, 1500)}`,
        tags: [
          ...new Set([
            ...(Array.isArray(c.tags) ? c.tags : []),
            `mode:${mode}`,
            `lineage:${root}`,
            `refines:${pref}`,
          ]),
        ],
      });
      return {
        ...brief(await createTheory(ownerId, c as any, actor, { submit: true, reasoning: args.reasoning })),
        parent: pref,
        lineage: root,
        generation,
      };
    }
    case 'review_theory': {
      need(role, ['judge'], name);
      const to = ({ approve: 'approved_for_code', revise: 'revise', reject: 'rejected_untestable' } as const)[
        args.decision as 'approve' | 'revise' | 'reject'
      ];
      if (!to) throw new HttpError(400, 'decision must be approve, revise or reject');
      return brief(
        await transitionTheory(ownerId, String(args.theory_id), to, actorOf('judge', meta), args.reasoning),
      );
    }
    case 'set_verdict': {
      need(role, ['judge'], name);
      if (args.verdict === 'revise')
        return brief(
          await transitionTheory(
            ownerId,
            String(args.theory_id),
            'revise_code',
            actorOf('judge', meta),
            args.reasoning,
          ),
        );
      if (args.verdict !== 'successful' && args.verdict !== 'failed')
        throw new HttpError(400, 'verdict must be successful, failed or revise');
      return mechanicalVerdict(
        ownerId,
        String(args.theory_id),
        args.verdict,
        String(args.reasoning ?? ''),
        meta,
      );
    }
    case 'submit_code':
      need(role, ['coder'], name);
      return submitCode(ownerId, args, actorOf('coder', meta), meta);
    default:
      throw new HttpError(404, `Unknown tool ${name}`);
  }
}

async function submitCode(ownerId: string, args: Record<string, any>, actor: TheoryActor, meta: Meta = {}) {
  let t = await getTheory(ownerId, String(args.theory_id ?? ''));
  const caps = await lifecycleCaps(ownerId);
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : 'submit_code';
  await assertClaim(t, meta);
  if (t.status === 'approved_for_code' || t.status === 'revise_code')
    t = await transitionTheory(ownerId, t._id, 'coding', actor, note);
  else if (t.status === 'code_error') {
    if (t.codeAttempts >= caps.maxCodeAttempts) {
      t = await transitionTheory(
        ownerId,
        t._id,
        'post_review',
        actor,
        `${caps.maxCodeAttempts} code attempts failed; handing to the Judge. Last error: ${lastError(t)}`,
      );
      return { ...brief(t), passed: false, next: 'The Judge decides this theory now; stop coding it.' };
    }
    t = await transitionTheory(ownerId, t._id, 'coding', actor, note);
  } else if (t.status !== 'coding')
    throw new HttpError(409, `T-${t.number} is ${t.status}; code is submitted only for an approved theory`);
  await claimTheory(t, meta);
  const pluginName = t.plugin?.name ?? slug(t);
  const result = (await testStrategy(ownerId, {
    code: String(args.code ?? ''),
    plugin: pluginName,
    note,
  })) as {
    passed: boolean;
    version?: number;
    error?: { type?: string; message?: string };
    summary?: { warnings?: { code: string }[] };
    next: string;
  };
  if ('version' in result && result.version)
    t = await linkTheory(ownerId, t._id, { pluginName, pluginVersion: result.version }, actor);
  if (!result.passed) {
    const problem = result.error
      ? `${result.error.type}: ${result.error.message}`
      : `warnings: ${(result.summary?.warnings ?? []).map((w: { code: string }) => w.code).join(', ')}`;
    t = await transitionTheory(ownerId, t._id, 'code_error', actor, problem.slice(0, 2000), {
      ...('version' in result && result.version ? { version: result.version } : {}),
    });
    const left = Math.max(0, caps.maxCodeAttempts - t.codeAttempts);
    return {
      ...result,
      ...brief(t),
      attempts_left: left,
      next: left
        ? 'Fix the code and call submit_code again.'
        : 'No attempts left: call submit_code once more to hand the theory to the Judge, or stop.',
    };
  }
  return {
    ...result,
    ...brief(t),
    next: `Passed. Evaluate it once with evaluate_strategy(theory_id="T-${t.number}", params=evaluation_params from the brief).`,
  };
}
const lastError = (t: Theory) =>
  [...t.history]
    .reverse()
    .find((h) => h.to === 'code_error')
    ?.reasoning.slice(0, 300) ?? 'unknown';

/**
 * evaluate_strategy for a theory (the Coder, theory in coding): runs the theory's plugin, links the evaluation
 * and, when it finishes, moves the theory to post_review (or code_error if the evaluation failed).
 */
/** #336: a new theory waits while the Coder's backlog is at its limit (a revision is not new and still goes). */
async function assertBacklogRoom(ownerId: string) {
  const { researchSettings, coderBacklog } = await import('./researchLoop.js');
  const [limit, waiting] = [(await researchSettings(ownerId)).maxCoderBacklog, await coderBacklog(ownerId)];
  if (waiting >= limit)
    throw new HttpError(
      409,
      `The Coder has ${waiting} ideas waiting for code (the limit is ${limit}, Research → Setup): no new theory until it catches up. Revise one sent back to you instead, or reply DONE.`,
    );
}

/**
 * A theory is evaluated on the research scope and window (Research → Setup), whatever names or dates the agent
 * passed (#319, #450: an agent that picks its own start and end can pick the years that worked). The agent may choose
 * side, top_n, rebalance and plugin_params.
 */
export async function scopedParams(ownerId: string, given: unknown) {
  const { evaluationParams } = await import('./researchLoop.js');
  const research = await evaluationParams(ownerId);
  const p = given && typeof given === 'object' ? { ...(given as Record<string, unknown>) } : {};
  if (!research) return p;
  const { start, end, ...names } = research;
  delete p.symbols;
  delete p.universe;
  return { ...p, start, end, ...names };
}

export async function evaluateForTheory(
  ownerId: string,
  role: ResearchRole | undefined,
  args: Record<string, any>,
  meta: Meta = {},
) {
  need(role, ['coder'], 'evaluate_strategy for a theory');
  const t = await getTheory(ownerId, String(args.theory_id));
  if (t.status !== 'coding')
    throw new HttpError(
      409,
      `T-${t.number} is ${t.status}; it is evaluated once per coding round, after submit_code passes`,
    );
  await assertClaim(t, meta);
  if (!t.plugin) throw new HttpError(409, `T-${t.number} has no code yet; call submit_code first`);
  if (t.forwardOnly)
    throw new HttpError(
      409,
      `T-${t.number} is forward_only: it needs estimate or consensus snapshots, which have no history to backtest. It goes to paper tracking (Layer 5) instead; a proxy from analyst_events can be backtested as a separate theory.`,
    );
  if (args.plugin && args.plugin !== t.plugin.name)
    throw new HttpError(400, `T-${t.number}'s plugin is ${t.plugin.name}`);
  const version = Number(args.version) || Math.max(...t.plugin.versions);
  // #373: one evaluation per code version at a time. A call that comes back while the first is still running
  // (the 50 s wait ran out) gets that evaluation, not a second one: a duplicate is a wasted trial.
  const running = await evaluations().findOne({
    ownerId,
    theoryId: t._id,
    pluginVersion: version,
    mode: 'explore',
    status: 'running',
  });
  if (running)
    return {
      ...agentSummary(running),
      theory: brief(t),
      next: `T-${t.number} v${version} is already being evaluated (${running._id}): call get_evaluation with that id in a minute; do not start another.`,
    };
  const { evaluation, done } = await startEvaluation(ownerId, {
    plugin: t.plugin.name,
    version,
    theoryId: t._id,
    params: await scopedParams(ownerId, args.params),
  });
  const evaluator = actorOf('evaluator', meta);
  const settled = done.then(async (e: Evaluation) => {
    await linkTheory(ownerId, t._id, { evaluationId: e._id }, evaluator);
    if (e.status === 'succeeded') {
      const s = e.record?.summary ?? {};
      await transitionTheory(
        ownerId,
        t._id,
        'evaluated',
        evaluator,
        `Evaluation ${e._id}: Sharpe ${s.sharpe}, CAGR ${s.cagr}, max drawdown ${s.max_drawdown}`,
      );
      await transitionTheory(ownerId, t._id, 'post_review', evaluator, 'Ready for the Judge');
    } else
      await transitionTheory(
        ownerId,
        t._id,
        'code_error',
        evaluator,
        `Evaluation failed: ${e.error?.message ?? 'unknown'}`,
      );
    return e;
  });
  settled.catch((err) => console.warn(`Theory T-${t.number} evaluation hook failed: ${err?.message ?? err}`));
  const finished = await Promise.race([
    settled.catch(() => undefined),
    new Promise<undefined>((r) => void setTimeout(r, WAIT_MAX_SECONDS * 1000)),
  ]);
  const e = finished ?? (await getEvaluation(ownerId, evaluation._id));
  return { ...agentSummary(e), theory: brief(await getTheory(ownerId, t._id)) };
}

/**
 * set_verdict successful | failed (#113): the gates decide. A successful request whose exploration gates pass
 * first runs the one-shot holdout (#105) when the theory has none. The Judge may downgrade a passing theory with
 * reasons, never upgrade a failing one. The gates version is locked by its first verdict.
 */
async function mechanicalVerdict(
  ownerId: string,
  theoryId: string,
  requested: 'successful' | 'failed',
  reasoning: string,
  meta: Meta,
) {
  let t = await getTheory(ownerId, theoryId);
  if (t.status !== 'post_review')
    throw new HttpError(409, `T-${t.number} is ${t.status}; a verdict is given in post_review`);
  const gates = await activeGates(ownerId);
  const evals = await Promise.all(
    t.evaluationIds.map((id) => getEvaluation(ownerId, id).catch(() => undefined)),
  );
  const explore = [...evals].reverse().find((e) => e && e.status === 'succeeded' && e.mode === 'explore') as
    Evaluation | undefined;
  let holdout = t.holdoutEvaluationId
    ? await getEvaluation(ownerId, t.holdoutEvaluationId).catch(() => undefined)
    : undefined;
  let results = evaluateGates(
    gates.gates,
    explore?.record,
    holdout?.status === 'succeeded' ? holdout.record : undefined,
  );
  if (requested === 'successful' && explore && exploreGatesPass(results) && !holdout) {
    // The exploration passed: spend the theory's one holdout shot on this code version.
    const { evaluation, done } = await startHoldoutEvaluation(ownerId, {
      plugin: explore.pluginName,
      version: explore.pluginVersion,
      theoryId: t._id,
      params: {
        ...(explore.params.symbols ? { symbols: explore.params.symbols } : {}),
        ...(explore.params.universe ? { universe: explore.params.universe } : {}),
        ...(explore.params.side ? { side: explore.params.side } : {}),
        ...(explore.params.top_n ? { top_n: explore.params.top_n } : {}),
        ...(explore.params.rebalance ? { rebalance: explore.params.rebalance } : {}),
        // #450: the holdout tests the configuration that was explored.
        ...(explore.params.plugin_params ? { plugin_params: explore.params.plugin_params } : {}),
      },
    });
    t = await linkTheory(ownerId, t._id, { holdoutEvaluationId: evaluation._id }, actorOf('evaluator', meta));
    holdout = await Promise.race([
      done.catch(() => undefined),
      new Promise<undefined>((r) => void setTimeout(r, WAIT_MAX_SECONDS * 1000)),
    ]);
    if (!holdout || holdout.status === 'running')
      return {
        ...brief(t),
        holdout_evaluation_id: evaluation._id,
        next: 'The holdout run is still going: call set_verdict again in a minute.',
      };
    results = evaluateGates(
      gates.gates,
      explore.record,
      holdout.status === 'succeeded' ? holdout.record : undefined,
    );
  } else if (holdout?.status === 'running')
    return {
      ...brief(t),
      holdout_evaluation_id: holdout._id,
      next: 'The holdout run is still going: call set_verdict again in a minute.',
    };
  const mechanical = outcomeOf(results, explore?.record?.excess?.spx?.excess_cagr);
  const problem = verdictProblem(requested, mechanical, reasoning);
  if (problem) throw new HttpError(409, `${problem}. Gates v${gates.version}: ${failing(results)}`);
  // Promising (#354) is the gates' label: it beat the S&P 500 but is not proven, whatever the Judge asked for.
  const to = mechanical === 'promising' ? 'promising' : requested;
  const why =
    mechanical === 'promising' && requested !== 'successful'
      ? `${reasoning}\n\nPromising by the gates: it beat the S&P 500; it failed only ${failingProof(results)}.`
      : reasoning;
  // #528: why it failed, from the gates and the record, for the vault, the brief and the near-miss list.
  const { causeOf } = await import('./learning.js');
  t = await transitionTheory(ownerId, t._id, to, actorOf('judge', meta), why, {
    gatesVersion: gates.version,
    mechanical,
    gates: results,
    ...(to !== 'successful' ? { cause: causeOf(results, explore?.record) } : {}),
    ...(typeof explore?.record?.excess?.spx?.excess_cagr === 'number'
      ? { excess: explore.record.excess.spx.excess_cagr }
      : {}),
    ...(explore ? { evaluationId: explore._id } : {}),
    ...(holdout ? { holdoutEvaluationId: holdout._id } : {}),
  });
  await lockGates(gates);
  return { ...brief(t), mechanical, gates_version: gates.version, gates: results };
}
const failingProof = (results: { gate: string; passed: boolean }[]) =>
  results
    .filter((r) => !r.passed && r.gate !== 'holdout')
    .map((r) => r.gate.replace('_', ' '))
    .join(' and ');
const failing = (results: { gate: string; passed: boolean; value: unknown; threshold: unknown }[]) =>
  results
    .filter((r) => !r.passed)
    .map((r) => `${r.gate} ${r.value ?? 'n/a'} (needs ${r.threshold})`)
    .join('; ') || 'all pass';

const claimant = (meta: Meta) => meta.agentId ?? meta.nodeId ?? meta.runId ?? 'coder';
/** A theory another Coder is working on (claimed within the last hours) is not yours to change. */
async function assertClaim(t: Theory, meta: Meta) {
  const { stale } = await import('./researchLoop.js');
  if (
    t.claim &&
    t.claim.by !== claimant(meta) &&
    !stale(t.claim.at) &&
    !['approved_for_code', 'revise_code'].includes(t.status)
  )
    throw new HttpError(
      409,
      `T-${t.number} is being coded by ${t.claim.by}; pick another theory from your brief`,
    );
}
async function claimTheory(t: Theory, meta: Meta) {
  const { theories } = await import('./theories.js');
  await theories().updateOne(
    { _id: t._id },
    { $set: { claim: { by: claimant(meta), ...(meta.runId ? { runId: meta.runId } : {}), at: new Date() } } },
  );
}
