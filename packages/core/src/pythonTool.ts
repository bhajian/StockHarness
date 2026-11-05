import type { CodeJobOutcome } from './codeJobs.js';
import type { ToolDefinition } from './llm.js';

/** The builtin tool that runs agent-written Python in a fresh executor container. */
export const PYTHON_TOOL = 'run_python';
/** Characters of stdout/stderr returned to the model per job; the full output stays on the job record. */
const STDOUT_CHARS = 6000;
const STDERR_CHARS = 3000;

export type PythonToolArguments = {
  code: string;
  params?: Record<string, unknown>;
  params_list?: Record<string, unknown>[];
  timeout_seconds?: number;
  purpose?: string;
};
export const pythonToolDefinition: ToolDefinition = {
  name: PYTHON_TOOL,
  description:
    'Run a complete Python 3.12 script you write, in a fresh container with numpy, pandas, polars, pyarrow, duckdb, scipy, numba, statsmodels, scikit-learn, lightgbm, TA-Lib, empyrical, exchange-calendars and pymongo. `import oh` gives oh.read(collection, filter=None, limit=None, sort=None), oh.read_df(...) (pandas), oh.write(collection, records, mode="append"|"replace"), oh.write_df(collection, frame, mode=...), oh.collections(), oh.params (your params) and oh.result(value) to hand back structured data; these reach this workspace’s MongoDB collections and nothing else. Print what you need to see: stdout and stderr come back. Give params_list to run the same code once per parameter set, each in its own container in parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The whole script. Set results with oh.result(...) or print them.',
      },
      params: {
        type: 'object',
        description: 'Values available to the script as oh.params (JSON object).',
      },
      params_list: {
        type: 'array',
        items: { type: 'object' },
        maxItems: 1000,
        description: 'Run the script once per entry, in parallel; each run sees one entry as oh.params.',
      },
      timeout_seconds: {
        type: 'integer',
        minimum: 10,
        description: 'Seconds the script may run (default from the agent or the installation).',
      },
      purpose: { type: 'string', maxLength: 200, description: 'What this run does, for the trace.' },
    },
    required: ['code'],
  },
};
/** The system-prompt note for agents that may run Python. */
export const pythonNote = (defaultTimeout: number) =>
  `\n\nYou can run Python with ${PYTHON_TOOL}: write a complete script, not a snippet; it runs in a fresh container each time (nothing persists between runs except what you write to collections). Use oh.read/oh.read_df to load this workspace’s MongoDB collections and oh.write/oh.write_df to store results in a collection, oh.result(value) for the structured answer you need back, and print() for anything else you want to see. Keep each job focused and idempotent; for many similar jobs (for example one per ticker) pass params_list and read oh.params in the script. Jobs may run up to ${defaultTimeout} seconds unless you set timeout_seconds. Check the returned status, stderr and result before building on them.`;
export type PythonFailure = {
  type: string;
  message: string;
  /** The agent's own frames (main.py), innermost last, with the code on that line. */
  lines: { line: number; function: string; code?: string }[];
  /** For a missing key or attribute: the fields of the collections the job read (#153). */
  fields?: Record<string, string[]>;
};
/** The exception, and the traceback trimmed to the agent's own code with its line numbers (#153). */
export function explainFailure(stderr: string, code?: string): PythonFailure | undefined {
  if (!stderr || !stderr.includes('Traceback')) return undefined;
  const src = (code ?? '').split('\n');
  const lines: PythonFailure['lines'] = [];
  for (const m of stderr.matchAll(/File "(?:[^"]*\/)?main\.py", line (\d+), in ([^\s]+)/g)) {
    const line = Number(m[1]);
    lines.push({
      line,
      function: m[2],
      ...(src[line - 1] !== undefined ? { code: src[line - 1].trim() } : {}),
    });
  }
  const last = stderr
    .trim()
    .split('\n')
    .reverse()
    .find((l) => /^[A-Za-z_][\w.]*(:|$)/.test(l.trim()));
  if (!last) return undefined;
  const [type, ...rest] = last.trim().split(':');
  return { type, message: rest.join(':').trim(), lines: lines.slice(-6) };
}
/** What the model sees for one job: the outcome with bounded output. */
export function summarizeJob(outcome: CodeJobOutcome, code?: string) {
  const failure = outcome.status === 'succeeded' ? undefined : explainFailure(outcome.stderr, code);
  return {
    ...(failure ? { failure } : {}),
    job_id: outcome.id,
    status: outcome.status,
    exit_code: outcome.exitCode,
    duration_ms: outcome.durationMs,
    ...(outcome.error ? { error: outcome.error } : {}),
    result: outcome.result,
    stdout: tail(outcome.stdout, STDOUT_CHARS),
    stderr: tail(outcome.stderr, STDERR_CHARS),
    ...(outcome.truncated ? { output_truncated: true } : {}),
  };
}
const tail = (text: string, chars: number) =>
  text.length > chars ? `… (${text.length - chars} earlier characters omitted)\n${text.slice(-chars)}` : text;

/**
 * For a KeyError / AttributeError (usually a wrong column name), add the catalog fields of the collections the
 * job read, so the agent can fix the name without guessing.
 */
export async function withFieldHints<T extends { failure?: PythonFailure }>(
  ownerId: string,
  summary: T,
  outcome: CodeJobOutcome,
): Promise<T> {
  if (!summary.failure || !['KeyError', 'AttributeError'].includes(summary.failure.type)) return summary;
  const stats = (outcome.meta?.stats ?? {}) as Record<string, { read?: number }>;
  const read = Object.keys(stats).filter((c) => stats[c]?.read);
  if (!read.length) return summary;
  const { listCatalog } = await import('./schemaCatalog.js');
  const entries = (await listCatalog(ownerId)).filter((e) => read.includes(e.collection));
  if (!entries.length) return summary;
  summary.failure.fields = Object.fromEntries(
    entries.map((e) => [e.collection, e.fields.map((f) => f.name)]),
  );
  return summary;
}
