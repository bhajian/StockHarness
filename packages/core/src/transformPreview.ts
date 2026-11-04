// Transform preview (#95): run a transform's code (saved or a draft) on a sample (20 symbols, one year) in the
// Python executor with OH_PREVIEW=1: oh writes are captured instead of stored, so nothing is written. Returns
// the first rows per output and per-output checks (key uniqueness, known_at, schema vs the catalog, nulls).
// Previews run in the background (an executor job can take longer than an HTTP request) and expire after a day.
import { randomUUID } from 'node:crypto';
import { collection, mongo } from './db.js';
import { HttpError, safeError } from './security.js';
import { runCodeJob, type CodeJobOutcome } from './codeJobs.js';
import { workspaceDatabase } from './mongoMcp.js';
import { UNIVERSE_COLLECTION } from './datasetCatalog.js';
import { catalogEntries } from './schemaCatalog.js';
import { addDays, today } from './datasetSync.js';
import { transformInputSchema, type TransformInput } from './transforms.js';
import { windowFor, type TransformWindow } from './transformRunner.js';

export type PreviewCheck = {
  id: 'rows' | 'key_unique' | 'key_present' | 'known_at' | 'schema' | 'nulls';
  status: 'pass' | 'warn' | 'fail';
  text: string;
};
export type PreviewCapture = {
  count: number;
  rows: Record<string, unknown>[];
  dup_keys: number;
  missing_key: number;
  missing_known_at: number;
  fields: Record<string, { type: string | null; null_pct: number }>;
  dq?: { issue_type: string; severity: string; security_id?: string; date?: string }[];
  truncated?: boolean;
};
export type PreviewOutput = PreviewCapture & { checks: PreviewCheck[] };
export type TransformPreview = {
  _id: string;
  ownerId: string;
  transformId?: string;
  transformName: string;
  status: 'running' | 'succeeded' | 'failed';
  window?: TransformWindow;
  symbols: string[];
  outputs?: Record<string, PreviewOutput>;
  reads?: Record<string, number>;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs?: number;
  createdAt: Date;
  finishedAt?: Date;
  expiresAt: Date;
};
export const transformPreviews = () => collection<TransformPreview>('transform_previews');
let indexed = false;
const PREVIEW_TIMEOUT_SECONDS = Number(process.env.TRANSFORM_PREVIEW_TIMEOUT_SECONDS) || 600;
export const SAMPLE_SIZE = 20;
const NULL_WARN_PCT = 50;

/** A sample of symbols: the largest names of the universe, else the first symbols found in an input. */
export async function sampleSymbols(ownerId: string, inputs: string[], n = SAMPLE_SIZE): Promise<string[]> {
  const db = mongo.db(workspaceDatabase(ownerId));
  const fromUniverse = await db
    .collection(UNIVERSE_COLLECTION)
    .find({ symbol: { $type: 'string' } }, { projection: { symbol: 1, marketCap: 1 } })
    .sort({ marketCap: -1 })
    .limit(n)
    .toArray()
    .catch(() => []);
  if (fromUniverse.length) return fromUniverse.map((d) => String(d.symbol));
  for (const c of inputs) {
    const rows = await db
      .collection(c)
      .aggregate([
        { $match: { symbol: { $type: 'string' } } },
        { $limit: 20000 },
        { $group: { _id: '$symbol' } },
        { $sort: { _id: 1 } },
        { $limit: n },
      ])
      .toArray()
      .catch(() => []);
    if (rows.length) return rows.map((r) => String(r._id));
  }
  return [];
}

/** Checks for one output's capture. `known` is the catalog's field list for that collection, if any. */
export function previewChecks(
  out: TransformInput['outputs'][number],
  cap: PreviewCapture,
  known?: string[],
): PreviewCheck[] {
  const checks: PreviewCheck[] = [];
  checks.push(
    cap.count
      ? { id: 'rows', status: 'pass', text: `${cap.count.toLocaleString('en-US')} rows` }
      : { id: 'rows', status: 'warn', text: 'No rows on the sample' },
  );
  checks.push(
    cap.missing_key
      ? {
          id: 'key_present',
          status: 'fail',
          text: `${cap.missing_key} rows without key ${out.key.join(', ')}`,
        }
      : { id: 'key_present', status: 'pass', text: `Key ${out.key.join(', ')} set on every row` },
  );
  checks.push(
    cap.dup_keys
      ? { id: 'key_unique', status: 'fail', text: `${cap.dup_keys} duplicate keys (${out.key.join(', ')})` }
      : { id: 'key_unique', status: 'pass', text: 'Key is unique' },
  );
  if (!out.static)
    checks.push(
      cap.missing_known_at
        ? {
            id: 'known_at',
            status: 'fail',
            text: `${cap.missing_known_at} rows without ${out.known_at_field}`,
          }
        : { id: 'known_at', status: 'pass', text: `${out.known_at_field} present on every row` },
    );
  const fields = Object.keys(cap.fields);
  if (known?.length && cap.count) {
    const ignore = new Set(['_id', '_hash', '_syncedAt']);
    const added = fields.filter((f) => !known.includes(f) && !ignore.has(f));
    const missing = known.filter((f) => !fields.includes(f) && !ignore.has(f));
    checks.push(
      added.length || missing.length
        ? {
            id: 'schema',
            status: 'warn',
            text: `Schema differs from the last run: ${[
              added.length ? `+${added.join(', +')}` : '',
              missing.length ? `−${missing.join(', −')}` : '',
            ]
              .filter(Boolean)
              .join('; ')}`,
          }
        : { id: 'schema', status: 'pass', text: 'Schema matches the last run' },
    );
  } else if (cap.count)
    checks.push({ id: 'schema', status: 'pass', text: 'New collection (no earlier schema)' });
  const nully = Object.entries(cap.fields)
    .filter(([, f]) => f.null_pct > NULL_WARN_PCT)
    .map(([k, f]) => `${k} ${f.null_pct}%`);
  if (nully.length) checks.push({ id: 'nulls', status: 'warn', text: `Mostly null: ${nully.join(', ')}` });
  return checks;
}

/** Start a preview of `spec` (a saved transform's spec or a draft). Nothing is written to any output. */
export async function startPreview(
  ownerId: string,
  draft: unknown,
  opts: {
    transformId?: string;
    start?: string;
    end?: string;
    symbols?: string[];
    autostart?: boolean;
    execute?: typeof runCodeJob;
  } = {},
) {
  const parsed = transformInputSchema.safeParse(draft);
  if (!parsed.success)
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const spec = parsed.data;
  if (!indexed) {
    await transformPreviews().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    indexed = true;
  }
  const end = opts.end ?? today();
  const start = opts.start ?? addDays(end, -365);
  if (start > end) throw new HttpError(400, 'start must be on or before end');
  const window = spec.incremental.mode === 'date_range' ? windowFor(spec, start, end) : undefined;
  const symbols = opts.symbols?.length
    ? opts.symbols.slice(0, 200)
    : await sampleSymbols(ownerId, spec.inputs);
  const now = new Date();
  const preview: TransformPreview = {
    _id: randomUUID(),
    ownerId,
    ...(opts.transformId ? { transformId: opts.transformId } : {}),
    transformName: spec.name,
    status: 'running',
    ...(window ? { window } : {}),
    symbols,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
  };
  await transformPreviews().insertOne(preview);
  const job = executePreview(preview, spec, opts.execute ?? runCodeJob);
  if (opts.autostart === false) await job;
  else void job;
  return preview;
}

async function executePreview(preview: TransformPreview, spec: TransformInput, execute: typeof runCodeJob) {
  const finish = (patch: Partial<TransformPreview>) =>
    transformPreviews().updateOne({ _id: preview._id }, { $set: { finishedAt: new Date(), ...patch } });
  let outcome: CodeJobOutcome;
  try {
    outcome = await execute(
      {
        ownerId: preview.ownerId,
        runId: `transform-preview-${preview._id}`,
        key: '1',
        signal: AbortSignal.timeout((PREVIEW_TIMEOUT_SECONDS + 300) * 1000),
      },
      {
        code: spec.code,
        params: spec.params,
        secrets: spec.secrets,
        timeoutSeconds: PREVIEW_TIMEOUT_SECONDS,
        purpose: `Preview of transform ${spec.name} (no writes)`,
        context: {
          OH_OUTPUTS: JSON.stringify(spec.outputs),
          OH_DQ_COLLECTION: spec.outputs[0].collection,
          OH_PREVIEW: '1',
          ...(preview.symbols.length ? { OH_SAMPLE_SYMBOLS: JSON.stringify(preview.symbols) } : {}),
          ...(preview.window ? { OH_WINDOW: JSON.stringify(preview.window) } : {}),
        },
      },
    );
  } catch (e) {
    await finish({ status: 'failed', error: safeError(e) });
    return;
  }
  const captures = (outcome.meta?.preview ?? {}) as Record<string, PreviewCapture>;
  const stats = (outcome.meta?.stats ?? {}) as Record<string, { read?: number }>;
  const reads: Record<string, number> = {};
  for (const [c, s] of Object.entries(stats)) if (s.read) reads[c] = s.read;
  const known = new Map(
    (
      await catalogEntries()
        .find(
          { ownerId: preview.ownerId, collection: { $in: spec.outputs.map((o) => o.collection) } },
          { projection: { collection: 1, 'fields.name': 1 } },
        )
        .toArray()
    ).map((e) => [e.collection, e.fields.map((f) => f.name)]),
  );
  const outputs: Record<string, PreviewOutput> = {};
  for (const o of spec.outputs) {
    const cap: PreviewCapture = captures[o.collection] ?? {
      count: 0,
      rows: [],
      dup_keys: 0,
      missing_key: 0,
      missing_known_at: 0,
      fields: {},
    };
    outputs[o.collection] = { ...cap, checks: previewChecks(o, cap, known.get(o.collection)) };
  }
  await finish({
    status: outcome.status === 'succeeded' ? 'succeeded' : 'failed',
    ...(outcome.status === 'succeeded' ? {} : { error: outcome.error ?? `The code ${outcome.status}` }),
    outputs,
    reads,
    stdout: (outcome.stdout ?? '').slice(-20000),
    stderr: (outcome.stderr ?? '').slice(-20000),
    durationMs: outcome.durationMs,
  });
}
