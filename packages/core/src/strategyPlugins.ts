// Strategy plugins (#103): agent- or human-written `signal(ctx)` code that the trusted evaluator runs. Every
// saved change is a new version (kept for audit, diff and the run–test–fix history, #153); the code hash pins
// what an evaluation ran. The authoritative contract check is pipeline/strategy/contract.py, run before every
// test or evaluation; `pluginProblems` is the quick check at save time.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collection } from './db.js';
import { HttpError } from './security.js';

/** The evaluator major version plugins are written for (pipeline/strategy/__init__.py EVALUATOR_MAJOR). */
export const EVALUATOR_MAJOR = '1';
const ALLOWED_IMPORTS = new Set([
  'math',
  'statistics',
  'numpy',
  'pandas',
  'datetime',
  'collections',
  'itertools',
  'functools',
  'typing',
  'dataclasses',
  'random',
  're',
  'bisect',
  'heapq',
  'operator',
  '__future__',
]);

export const strategyPluginInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lowercase letters, digits and _, starting with a letter'),
  description: z.string().max(2000).optional(),
  code: z.string().min(1).max(100_000), // passed to the executor in its params
  evaluatorVersion: z.string().regex(/^\d+$/).default(EVALUATOR_MAJOR),
});
export type StrategyPluginInput = z.infer<typeof strategyPluginInput>;
export type StrategyPlugin = StrategyPluginInput & {
  _id: string;
  ownerId: string;
  version: number;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
};
export type StrategyPluginVersion = {
  _id: string; // `${pluginId}:${version}`
  ownerId: string;
  pluginId: string;
  name: string;
  version: number;
  code: string;
  hash: string;
  description?: string;
  evaluatorVersion: string;
  note?: string;
  /** The test_strategy error this version produced, if any (#153). */
  error?: string;
  createdAt: Date;
  createdBy?: string;
};
export const strategyPlugins = () => collection<StrategyPlugin>('strategy_plugins');
export const strategyPluginVersions = () => collection<StrategyPluginVersion>('strategy_plugin_versions');

export const codeHash = (code: string) => `sha256:${createHash('sha256').update(code, 'utf8').digest('hex')}`;

/** Quick save-time checks (the Python contract check is authoritative). */
export function pluginProblems(p: StrategyPluginInput): string[] {
  const problems: string[] = [];
  if (!/^def signal\(\s*\w+\s*\)/m.test(p.code)) problems.push('The plugin must define signal(ctx)');
  if (!/^META\s*=/m.test(p.code)) problems.push('The plugin must define META = {...}');
  p.code.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)/);
    const mod = m && (m[1] ?? m[2]).split('.')[0];
    if (mod && !ALLOWED_IMPORTS.has(mod)) problems.push(`line ${i + 1}: import ${mod} is not allowed`);
  });
  if (p.evaluatorVersion !== EVALUATOR_MAJOR)
    problems.push(
      `evaluatorVersion ${p.evaluatorVersion} is not supported (this evaluator is ${EVALUATOR_MAJOR})`,
    );
  return problems;
}

const specOf = (p: StrategyPlugin | StrategyPluginInput): StrategyPluginInput =>
  strategyPluginInput.parse({
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    code: p.code,
    evaluatorVersion: p.evaluatorVersion,
  });
const same = (a: StrategyPluginInput, b: StrategyPluginInput) => JSON.stringify(a) === JSON.stringify(b);

function versionRow(
  p: StrategyPlugin,
  extra: { note?: string; error?: string; createdBy?: string; createdAt?: Date } = {},
): StrategyPluginVersion {
  return {
    _id: `${p._id}:${p.version}`,
    ownerId: p.ownerId,
    pluginId: p._id,
    name: p.name,
    version: p.version,
    code: p.code,
    hash: p.hash,
    ...(p.description ? { description: p.description } : {}),
    evaluatorVersion: p.evaluatorVersion,
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.error ? { error: extra.error } : {}),
    createdAt: extra.createdAt ?? p.updatedAt,
    ...(extra.createdBy ? { createdBy: extra.createdBy } : {}),
  };
}

export async function createStrategyPlugin(
  ownerId: string,
  input: unknown,
  userId?: string,
  opts: { note?: string } = {},
) {
  const spec = strategyPluginInput.parse(input);
  const problems = pluginProblems(spec);
  if (problems.length) throw new HttpError(400, problems.join('; '));
  if (await strategyPlugins().findOne({ ownerId, name: spec.name }, { projection: { _id: 1 } }))
    throw new HttpError(409, `A strategy plugin named ${spec.name} already exists`);
  const now = new Date();
  const doc: StrategyPlugin = {
    ...spec,
    _id: randomUUID(),
    ownerId,
    version: 1,
    hash: codeHash(spec.code),
    createdAt: now,
    updatedAt: now,
    ...(userId ? { createdBy: userId } : {}),
  };
  await strategyPlugins().insertOne(doc);
  await strategyPluginVersions().insertOne(versionRow(doc, { ...opts, createdBy: userId }));
  return doc;
}

/** Save a new version (a no-op when nothing changed). */
export async function updateStrategyPlugin(
  ownerId: string,
  id: string,
  input: unknown,
  userId?: string,
  opts: { note?: string } = {},
) {
  const prev = await strategyPlugins().findOne({ _id: id, ownerId });
  if (!prev) throw new HttpError(404, 'Strategy plugin not found');
  const spec = strategyPluginInput.parse({ ...(input as object), name: prev.name });
  if (same(specOf(prev), spec)) return prev;
  const problems = pluginProblems(spec);
  if (problems.length) throw new HttpError(400, problems.join('; '));
  const next: StrategyPlugin = {
    ...prev,
    ...spec,
    ...(spec.description ? {} : { description: undefined }),
    version: prev.version + 1,
    hash: codeHash(spec.code),
    updatedAt: new Date(),
    ...(userId ? { updatedBy: userId } : {}),
  };
  await strategyPluginVersions().insertOne(versionRow(next, { ...opts, createdBy: userId }));
  const { _id, ownerId: _o, createdAt, createdBy, ...set } = next;
  const r = await strategyPlugins().updateOne(
    { _id: id, ownerId, version: prev.version },
    {
      $set: Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)),
      ...(spec.description ? {} : { $unset: { description: '' } }),
    },
  );
  if (!r.matchedCount) {
    await strategyPluginVersions().deleteOne({ _id: `${id}:${next.version}` });
    throw new HttpError(409, 'This plugin changed meanwhile. Reopen it and save again.');
  }
  return (await strategyPlugins().findOne({ _id: id, ownerId }))!;
}

export async function deleteStrategyPlugin(ownerId: string, id: string) {
  const r = await strategyPlugins().deleteOne({ _id: id, ownerId });
  if (!r.deletedCount) throw new HttpError(404, 'Strategy plugin not found');
  // Versions stay for audit: evaluations reference the code hash they ran.
}

/** A plugin by id or name, at its current or a given version. */
export async function resolveStrategyPlugin(ownerId: string, ref: string, version?: number) {
  const p = await strategyPlugins().findOne({ ownerId, $or: [{ _id: ref }, { name: ref }] });
  if (!p) throw new HttpError(404, `No strategy plugin named ${ref}`);
  if (!version || version === p.version) return { plugin: p, code: p.code, hash: p.hash, version: p.version };
  const v = await strategyPluginVersions().findOne({ _id: `${p._id}:${version}`, ownerId });
  if (!v) throw new HttpError(404, `${p.name} has no version ${version}`);
  return { plugin: p, code: v.code, hash: v.hash, version: v.version };
}

export async function listStrategyPluginVersions(ownerId: string, pluginId: string) {
  return strategyPluginVersions().find({ ownerId, pluginId }).sort({ version: -1 }).limit(200).toArray();
}

// --- YAML (kind StrategyPlugin) ---------------------------------------------------------------------------
export type StrategyPluginHistoryEntry = {
  version: number;
  hash: string;
  code: string;
  description?: string;
  evaluatorVersion?: string;
  note?: string;
  error?: string;
};
export const strategyPluginHistorySchema = z.array(
  z.object({
    version: z.number().int().min(1),
    hash: z.string(),
    code: z.string().min(1),
    description: z.string().optional(),
    evaluatorVersion: z.string().optional(),
    note: z.string().max(500).optional(),
    error: z.string().max(20000).optional(),
  }),
);

/** The exported spec: code verbatim with its hash (checked on import). */
export function strategyPluginSpec(p: StrategyPlugin) {
  return {
    ...(p.description ? { description: p.description } : {}),
    evaluatorVersion: p.evaluatorVersion,
    hash: p.hash,
    code: p.code,
  };
}

/** Earlier versions, oldest first (the current one is the spec itself). */
export async function strategyPluginHistory(ownerId: string, p: StrategyPlugin) {
  const rows = await strategyPluginVersions()
    .find({ ownerId, pluginId: p._id, version: { $lt: p.version } })
    .sort({ version: 1 })
    .toArray();
  return rows.map((v): StrategyPluginHistoryEntry => ({
    version: v.version,
    hash: v.hash,
    code: v.code,
    ...(v.description ? { description: v.description } : {}),
    evaluatorVersion: v.evaluatorVersion,
    ...(v.note ? { note: v.note } : {}),
    ...(v.error ? { error: v.error } : {}),
  }));
}

/** Hash problems in an imported spec (the code must match the hash it claims). */
export function strategyPluginHashProblems(spec: { hash?: unknown; code?: unknown; history?: unknown }) {
  const problems: string[] = [];
  if (typeof spec.code === 'string' && spec.hash !== codeHash(spec.code))
    problems.push('hash does not match the code');
  if (Array.isArray(spec.history))
    for (const h of spec.history as { version?: number; hash?: string; code?: string }[])
      if (typeof h.code === 'string' && h.hash !== codeHash(h.code))
        problems.push(`history version ${h.version}: hash does not match the code`);
  return problems;
}

/** After an import created a plugin (v1 = the current code), recreate its earlier versions in order. */
export async function restoreStrategyPluginHistory(
  ownerId: string,
  id: string,
  history: StrategyPluginHistoryEntry[],
  userId?: string,
) {
  if (!history.length) return;
  const p = await strategyPlugins().findOne({ _id: id, ownerId });
  if (!p) throw new HttpError(404, 'Strategy plugin not found');
  const current = history.length + 1;
  const now = Date.now();
  await strategyPluginVersions().deleteMany({ ownerId, pluginId: id });
  await strategyPluginVersions().insertMany([
    ...history.map((h, i) => ({
      _id: `${id}:${i + 1}`,
      ownerId,
      pluginId: id,
      name: p.name,
      version: i + 1,
      code: h.code,
      hash: h.hash,
      ...(h.description ? { description: h.description } : {}),
      evaluatorVersion: h.evaluatorVersion ?? EVALUATOR_MAJOR,
      ...(h.note ? { note: h.note } : {}),
      ...(h.error ? { error: h.error } : {}),
      createdAt: new Date(now - (current - i)),
      ...(userId ? { createdBy: userId } : {}),
    })),
    versionRow({ ...p, version: current }, { createdBy: userId, createdAt: new Date(now) }),
  ]);
  await strategyPlugins().updateOne({ _id: id, ownerId }, { $set: { version: current } });
}
