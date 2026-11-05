// Lifecycle MCP tools (#112), served on the research connection. The connection's role decides what its agent
// may do (the Judge reviews and gives verdicts, the Coder submits code, the Theorist submits theories); every write
// is a legal transition of the state machine (#110) with its reasoning. Read tools are open to every role.
import { HttpError } from './security.js';
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
import { getEvaluation, startEvaluation, type Evaluation } from './evaluations.js';
import { agentSummary, testStrategy } from './strategyTools.js';
import type { TheoryRole } from './theoryLifecycle.js';

export type ResearchRole = 'theorist' | 'judge' | 'coder';
type Meta = { agentId?: string; runId?: string; model?: string };
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
  direction: { type: 'string', enum: ['long', 'short', 'long_short'] },
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
  return {
    ...brief(t),
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
    case 'search_theories':
      return searchTheories(ownerId, String(args.text ?? ''), Math.min(50, Number(args.limit) || 10));
    case 'get_theory':
      return theoryView(ownerId, await getTheory(ownerId, String(args.theory_id ?? '')));
    case 'submit_theory': {
      need(role, ['theorist'], name);
      const actor = actorOf('theorist', meta);
      if (args.theory_id) {
        const t = await getTheory(ownerId, String(args.theory_id));
        const edited = await editTheory(ownerId, t._id, content(args), actor, args.reasoning);
        return brief(await transitionTheory(ownerId, edited._id, 'pre_review', actor, args.reasoning));
      }
      return brief(
        await createTheory(ownerId, content(args), actor, { submit: true, reasoning: args.reasoning }),
      );
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
      const to = ({ successful: 'successful', failed: 'failed', revise: 'revise_code' } as const)[
        args.verdict as 'successful' | 'failed' | 'revise'
      ];
      if (!to) throw new HttpError(400, 'verdict must be successful, failed or revise');
      return brief(
        await transitionTheory(ownerId, String(args.theory_id), to, actorOf('judge', meta), args.reasoning),
      );
    }
    case 'submit_code':
      need(role, ['coder'], name);
      return submitCode(ownerId, args, actorOf('coder', meta));
    default:
      throw new HttpError(404, `Unknown tool ${name}`);
  }
}

async function submitCode(ownerId: string, args: Record<string, any>, actor: TheoryActor) {
  let t = await getTheory(ownerId, String(args.theory_id ?? ''));
  const caps = await lifecycleCaps(ownerId);
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : 'submit_code';
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
    next: `Passed. Evaluate it once with evaluate_strategy(theory_id="T-${t.number}", params={start, end, symbols}).`,
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
  if (!t.plugin) throw new HttpError(409, `T-${t.number} has no code yet; call submit_code first`);
  if (args.plugin && args.plugin !== t.plugin.name)
    throw new HttpError(400, `T-${t.number}'s plugin is ${t.plugin.name}`);
  const version = Number(args.version) || Math.max(...t.plugin.versions);
  const { evaluation, done } = await startEvaluation(ownerId, {
    plugin: t.plugin.name,
    version,
    theoryId: t._id,
    params: args.params,
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
