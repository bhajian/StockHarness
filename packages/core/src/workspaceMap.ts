// The workspace map (#312): the whole chain on one page — data sources (Layer 1 syncs) → data prep (Layer 2
// transforms: what each reads and writes, when it runs, its last run) → research setup (scope, the agents with
// their models and skills) → ideas → evaluations → simulations, with a "start here" checklist. Plain words only:
// every item says what it is, when it runs and where to see its result.
import { collection } from './db.js';
import { datasetSyncs } from './datasetSync.js';
import { catalogById } from './datasetCatalog.js';
import { describeSchedule } from './schedule.js';
import { listCatalog } from './schemaCatalog.js';
import { transforms } from './transforms.js';
import { researchSettings } from './researchLoop.js';
import { researchHow } from './researchCycles.js';
import { budgetState } from './spendGuard.js';
import { theories } from './theories.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function workspaceMap(ownerId: string) {
  const [syncs, trs, catalog, settings] = await Promise.all([
    datasetSyncs().find({ ownerId }).sort({ name: 1 }).toArray(),
    transforms().find({ ownerId }).toArray(),
    listCatalog(ownerId),
    researchSettings(ownerId),
  ]);
  const cat = new Map(catalog.map((c) => [c.collection, c]));
  const stats = (name: string) => {
    const c = cat.get(name);
    return c ? { rows: c.coverage?.rows ?? null, latest: c.coverage?.dateMax ?? null, layer: c.layer } : null;
  };

  // 1. Data sources.
  const writtenBy = new Map<string, { kind: 'sync' | 'transform'; name: string }>();
  const sources = syncs.map((s) => {
    const coll = s.targetCollection || catalogById.get(s.dataset)?.defaultCollection || s.dataset;
    writtenBy.set(coll, { kind: 'sync', name: s.name });
    const status = !s.enabled
      ? 'off'
      : (s as any).pausedReason
        ? 'paused'
        : s.lastError
          ? 'failing'
          : s.schedule?.enabled
            ? 'ok'
            : 'manual';
    return {
      id: s._id,
      name: s.name,
      collection: coll,
      runs: s.schedule?.enabled ? describeSchedule(s.schedule as any) : 'Only when run by hand',
      lastRunAt: s.lastRunAt ?? null,
      status,
      ...(s.lastError ? { error: String(s.lastError).slice(0, 200) } : {}),
      ...((s as any).pausedReason ? { pausedReason: (s as any).pausedReason } : {}),
      ...stats(coll),
    };
  });

  // 2. Data prep, in the order the triggers run them.
  for (const t of trs)
    for (const o of t.outputs) writtenBy.set(o.collection, { kind: 'transform', name: t.name });
  const lastRuns = await collection<any>('transform_runs')
    .aggregate([
      { $match: { ownerId } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$transformName', run: { $first: '$$ROOT' } } },
    ])
    .toArray();
  const lastOf = new Map(lastRuns.map((r) => [r._id, r.run]));
  const depth = new Map<string, number>();
  const level = (name: string, seen = new Set<string>()): number => {
    if (depth.has(name)) return depth.get(name)!;
    const t = trs.find((x) => x.name === name);
    if (!t || seen.has(name)) return 0;
    seen.add(name);
    const ups = (t.trigger?.after ?? []).filter((a) => a.startsWith('transform:')).map((a) => a.slice(10));
    const d = ups.length ? 1 + Math.max(...ups.map((u) => level(u, seen))) : 0;
    depth.set(name, d);
    return d;
  };
  const sourceName = (key: string) => {
    const [kind, name] = key.split(':') as ['dataset' | 'transform', string];
    if (kind === 'transform') return `the ${name} transform`;
    const s = syncs.find(
      (x) =>
        (x.targetCollection || catalogById.get(x.dataset)?.defaultCollection) === name || x.dataset === name,
    );
    return s ? `the "${s.name}" sync` : `the ${name} sync`;
  };
  const prep = trs
    .map((t) => {
      const run = lastOf.get(t.name);
      const after = t.trigger?.after ?? [];
      const runs = [
        after.length
          ? `Automatically, after ${after.map(sourceName).join(' and ')} finish${after.length === 1 ? 'es' : ''}`
          : '',
        t.trigger?.schedule?.enabled ? describeSchedule(t.trigger.schedule as any) : '',
      ].filter(Boolean);
      return {
        id: t._id,
        name: t.name,
        description: t.description ?? '',
        enabled: t.enabled !== false,
        step: level(t.name),
        reads: (t.inputs ?? []).map((c) => ({ collection: c, from: writtenBy.get(c) ?? null })),
        writes: t.outputs.map((o) => ({ collection: o.collection, ...stats(o.collection) })),
        runs: runs.length ? runs.join('; ') : 'Only when run by hand',
        lastRun: run
          ? {
              status: run.status,
              at: run.createdAt,
              durationMs: run.durationMs ?? null,
              rows: Object.values(run.outputs ?? {}).reduce((n: number, o: any) => n + (o.written ?? 0), 0),
              ...(run.window ? { window: `${run.window.start} → ${run.window.end}` } : {}),
              ...(run.error ? { error: String(run.error.message ?? run.error).slice(0, 200) } : {}),
            }
          : null,
      };
    })
    .sort((a, b) => a.step - b.step || a.name.localeCompare(b.name));

  // 3. Research setup.
  const how = await researchHow(ownerId).catch(() => null);
  const agents = (how?.steps ?? []).flatMap((s: any) =>
    s.kind === 'parallel' ? s.agents : s.kind === 'agent' ? [s] : [],
  );
  const scope =
    settings.scope?.kind === 'top_market_cap'
      ? `the ${settings.scope.top} largest US stocks by market cap on each date${settings.scope.top === 500 ? ' (S&P 500 proxy)' : ''}`
      : `${plural(settings.evaluationSymbols.length, 'symbol')}: ${settings.evaluationSymbols.slice(0, 8).join(', ')}${settings.evaluationSymbols.length > 8 ? ' …' : ''}`;
  // What the research agents can read through their data tools: point-in-time and static collections.
  const readable = catalog.filter((c) => ['pit', 'static'].includes(c.timeSemantics?.status));
  const research = {
    installed: !!how,
    paused: !!settings.paused,
    runs:
      how?.harness?.schedule && (how.harness.schedule as any).enabled
        ? `${describeSchedule(how.harness.schedule as any)}${(how.harness.schedule as any).until ? ` until ${new Date((how.harness.schedule as any).until).toLocaleString()}` : ''}`
        : 'Not scheduled',
    scope,
    years: settings.evaluationYears,
    focus: settings.focus.slice(0, 400),
    agents: agents.map((a: any) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      model: a.model?.model ?? null,
      modelName: a.model?.name ?? null,
      skills: a.skills.map((k: any) => k.name),
      tools: a.connections.reduce((n: number, c: any) => n + c.tools.length, 0),
    })),
    readable: readable.map((c) => c.collection).sort(),
    spend: await budgetState(ownerId).catch(() => null),
  };

  // 4–6. What came out.
  const byStatus = await theories()
    .aggregate<{ _id: string; n: number }>([
      { $match: { ownerId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ])
    .toArray();
  const count = (...s: string[]) => byStatus.filter((x) => s.includes(x._id)).reduce((a, x) => a + x.n, 0);
  const ideas = {
    total: byStatus.reduce((a, x) => a + x.n, 0),
    successful: count('successful', 'approved'),
    promising: count('promising'),
    failed: count('failed', 'rejected_untestable'),
    inProgress: count(
      'draft',
      'pre_review',
      'revise',
      'approved_for_code',
      'coding',
      'code_error',
      'evaluated',
      'post_review',
      'revise_code',
    ),
  };
  const evaluations = {
    total: await collection('evaluations').countDocuments({ ownerId }),
    holdouts: await collection('evaluations').countDocuments({ ownerId, mode: 'holdout' }),
  };
  const lastSim = await collection<any>('simulations')
    .find(
      { ownerId },
      {
        projection: {
          name: 1,
          status: 1,
          createdAt: 1,
          'result.summary.cagr': 1,
          'result.summary.sharpe': 1,
        },
      },
    )
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  const simulations = {
    total: await collection('simulations').countDocuments({ ownerId }),
    last: lastSim
      ? {
          id: lastSim._id,
          name: lastSim.name,
          status: lastSim.status,
          cagr: lastSim.result?.summary?.cagr ?? null,
          sharpe: lastSim.result?.summary?.sharpe ?? null,
        }
      : null,
  };

  // Start here: the first step that needs attention.
  const failing = sources.filter((s) => s.status === 'failing' || s.status === 'paused');
  const prepFailed = prep.filter((t) => t.lastRun?.status === 'failed');
  const checklist = [
    {
      step: 'data',
      label: 'Data is syncing',
      done: sources.some((s) => s.status === 'ok') && !failing.length,
      detail: failing.length
        ? `${plural(failing.length, 'sync')} need attention: ${failing.map((s) => s.name).join(', ')}`
        : `${plural(sources.filter((s) => s.status === 'ok').length, 'sync')} on a schedule`,
      href: '/datasets/syncs',
    },
    {
      step: 'prep',
      label: 'Data is prepared (point in time)',
      done: prep.length > 0 && !prepFailed.length,
      detail: prepFailed.length
        ? `${plural(prepFailed.length, 'transform')} failed last time: ${prepFailed.map((t) => t.name).join(', ')}`
        : `${plural(prep.length, 'transform')} keep ${plural(
            prep.reduce((n, t) => n + t.writes.length, 0),
            'collection',
          )} current`,
      href: '/datasets/transforms',
    },
    {
      step: 'setup',
      label: 'Research is set up',
      done: research.installed,
      detail: research.installed
        ? `${plural(agents.length, 'agent')} · scope: ${scope}`
        : 'Choose the scope, the models and the skills, then Start',
      href: '/research/setup',
    },
    {
      step: 'running',
      label: 'Research is running',
      done: research.installed && !research.paused && research.runs !== 'Not scheduled',
      detail: research.paused ? 'Paused' : research.runs,
      href: '/research',
    },
    {
      step: 'ideas',
      label: 'Ideas are coming out',
      done: ideas.total > 0,
      detail: `${plural(ideas.total, 'idea')} · ${ideas.successful} successful · ${ideas.promising} promising · ${ideas.failed} failed · ${ideas.inProgress} in progress`,
      href: '/ideas?show=all',
    },
    {
      step: 'simulate',
      label: 'An idea has been simulated',
      done: simulations.total > 0,
      detail: simulations.total
        ? `${plural(simulations.total, 'simulation')}`
        : 'Open an idea and press Simulate',
      href: '/simulations',
    },
  ];
  return { checklist, sources, prep, research, ideas, evaluations, simulations };
}
