// The research vault (#459): loads the theories and their latest exploration and serves the notes (vaultNotes.ts) to
// the agents' tools: vault_index, vault_search, vault_read (a note or one section) and vault_backlinks.
import { collection } from './db.js';
import { theories } from './theories.js';
import { activeGates, evaluateGates } from './gates.js';
import { buildVault, search, sections, type Note, type VaultIdea } from './vaultNotes.js';

const cache = new Map<string, { at: number; notes: Note[] }>();
const TTL_MS = 60_000;

export async function vaultNotes(ownerId: string): Promise<Note[]> {
  const hit = cache.get(ownerId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.notes;
  const ts = await theories()
    .find(
      { ownerId },
      {
        projection: {
          number: 1,
          title: 1,
          status: 1,
          family: 1,
          history: 1,
          hypothesis: 1,
          signalLogic: 1,
          createdAt: 1,
        },
      },
    )
    .toArray();
  const evals = await collection<any>('evaluations')
    .find(
      { ownerId, mode: 'explore', status: 'succeeded', theoryId: { $in: ts.map((t) => t._id) } },
      { projection: { theoryId: 1, createdAt: 1, record: 1 } },
    )
    .sort({ createdAt: 1 })
    .toArray();
  const latest = new Map<string, any>();
  for (const e of evals) latest.set(e.theoryId, e);
  const gates = (await activeGates(ownerId)).gates;
  const ideas: VaultIdea[] = ts.map((t: any) => {
    const e = latest.get(t._id);
    const r = e?.record;
    const failing = r
      ? evaluateGates(gates, r)
          .filter((g) => !g.passed && !g.gate.startsWith('holdout'))
          .map((g) => g.gate)
      : [];
    const judge = [...(t.history ?? [])]
      .reverse()
      .find((h: any) => h.actor?.role === 'judge' && h.reasoning)?.reasoning;
    const created = (t.history ?? []).find((h: any) => h.type === 'create');
    return {
      ref: `T-${t.number}`,
      title: t.title,
      status: t.status,
      family: t.family || 'unknown',
      model: created?.actor?.model ?? 'unknown',
      hypothesis: String(t.hypothesis ?? '').slice(0, 1200),
      signalLogic: String(t.signalLogic ?? '').slice(0, 1200),
      createdAt: new Date(t.createdAt).toISOString(),
      sharpe: r?.summary?.sharpe ?? null,
      excess: r?.excess?.spx?.excess_cagr ?? null,
      dsr: r?.trial_context?.dsr ?? null,
      trades: r?.trade_stats?.count ?? null,
      failingGates: failing,
      ...(judge ? { judge: String(judge).slice(0, 800) } : {}),
    };
  });
  const notes = buildVault(ideas);
  cache.set(ownerId, { at: Date.now(), notes });
  return notes;
}

export async function vaultTool(ownerId: string, name: string, args: Record<string, any>) {
  const notes = await vaultNotes(ownerId);
  const byPath = new Map(notes.map((n) => [n.path, n]));
  switch (name) {
    case 'vault_index':
      return {
        start: byPath.get('index')?.body,
        notes: notes.length,
        families: notes
          .filter((n) => n.path.startsWith('families/'))
          .map((n) => ({ path: n.path, title: n.title })),
      };
    case 'vault_search':
      return { results: search(notes, String(args.text ?? ''), Math.min(30, Number(args.limit) || 10)) };
    case 'vault_read': {
      const n = byPath.get(
        String(args.path ?? '')
          .replace(/^\[\[|\]\]$/g, '')
          .replace(/\.md$/, ''),
      );
      if (!n) return { error: `No note ${args.path}; start with vault_index or vault_search` };
      if (args.section) {
        const s = sections(n.body)[String(args.section)];
        return s === undefined
          ? { error: `No section "${args.section}"`, sections: Object.keys(sections(n.body)) }
          : { path: n.path, section: args.section, text: s, links: n.links };
      }
      return {
        path: n.path,
        title: n.title,
        text: n.body.slice(0, 12000),
        sections: Object.keys(sections(n.body)),
        links: n.links,
      };
    }
    case 'vault_backlinks': {
      const p = String(args.path ?? '');
      return {
        path: p,
        backlinks: notes.filter((n) => n.links.includes(p)).map((n) => ({ path: n.path, title: n.title })),
      };
    }
  }
  return { error: `unknown vault tool ${name}` };
}
