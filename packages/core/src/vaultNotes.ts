// The research vault (#459): linked Markdown notes the agents navigate step by step (index → family → idea, search,
// read one section, backlinks) instead of carrying every past idea in their prompt. Notes are generated from the
// theories and their evaluations, so they are always current. Pure, so it is unit-tested; vault.ts loads the data.

export type VaultIdea = {
  ref: string; // T-123
  title: string;
  status: string;
  family: string;
  model: string;
  hypothesis?: string;
  signalLogic?: string;
  createdAt: string;
  sharpe?: number | null;
  excess?: number | null;
  dsr?: number | null;
  trades?: number | null;
  failingGates: string[];
  judge?: string; // the Judge's last reasoning
};
export type Note = { path: string; title: string; body: string; links: string[] };

const slug = (s: string) =>
  String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
const pct = (x?: number | null) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');
const num = (x?: number | null) => (typeof x === 'number' ? x.toFixed(2) : '—');
const OK = new Set(['promising', 'successful', 'approved']);
const link = (p: string) => `[[${p}]]`;
const linksOf = (body: string) => [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))];

export function ideaNote(i: VaultIdea): Note {
  const fam = `families/${slug(i.family)}`;
  const body = [
    `# ${i.ref} ${i.title}`,
    '',
    `Status **${i.status}** · family ${link(fam)} · proposed by ${i.model} on ${i.createdAt.slice(0, 10)}`,
    '',
    '## Hypothesis',
    i.hypothesis || '—',
    '',
    '## Signal',
    i.signalLogic || '—',
    '',
    '## Result',
    `Sharpe (over cash) ${num(i.sharpe)} · excess over the S&P 500 ${pct(i.excess)} a year · deflated Sharpe ${num(i.dsr)} · round trips ${i.trades ?? '—'}`,
    '',
    '## Post-mortem',
    i.failingGates.length
      ? `Failed: ${i.failingGates.join(', ')}. See ${link('lessons/gates')}.`
      : OK.has(i.status)
        ? 'Passed the exploration gates.'
        : 'No evaluation yet, or not judged.',
    i.judge ? `\nThe Judge: ${i.judge}` : '',
  ].join('\n');
  return { path: `ideas/${i.ref}`, title: `${i.ref} ${i.title}`, body, links: linksOf(body) };
}

export function familyNote(family: string, ideas: VaultIdea[]): Note {
  const ok = ideas.filter((i) => OK.has(i.status));
  const gates = new Map<string, number>();
  for (const i of ideas) for (const g of i.failingGates) gates.set(g, (gates.get(g) ?? 0) + 1);
  const ranked = [...ideas]
    .filter((i) => typeof i.sharpe === 'number')
    .sort((a, b) => (b.sharpe as number) - (a.sharpe as number));
  const line = (i: VaultIdea) =>
    `- ${link(`ideas/${i.ref}`)} ${i.title} — ${i.status}, Sharpe ${num(i.sharpe)}, excess ${pct(i.excess)}`;
  const body = [
    `# Family: ${family}`,
    '',
    `${ideas.length} ideas · ${ok.length} promising or successful · yield ${ideas.length ? ((ok.length / ideas.length) * 100).toFixed(0) : 0} per 100`,
    '',
    '## Lessons',
    gates.size
      ? [...gates]
          .sort((a, b) => b[1] - a[1])
          .map(([g, n]) => `- ${g} failed ${n} time${n === 1 ? '' : 's'}`)
          .join('\n')
      : '- No gate failures recorded.',
    '',
    '## Best',
    ranked.slice(0, 5).map(line).join('\n') || '—',
    '',
    '## Worst',
    ranked.slice(-5).reverse().map(line).join('\n') || '—',
    '',
    '## All ideas',
    ideas.map((i) => `- ${link(`ideas/${i.ref}`)} ${i.title} (${i.status})`).join('\n'),
  ].join('\n');
  return { path: `families/${slug(family)}`, title: `Family: ${family}`, body, links: linksOf(body) };
}

export function gatesNote(ideas: VaultIdea[]): Note {
  const by = new Map<string, VaultIdea[]>();
  for (const i of ideas) for (const g of i.failingGates) by.set(g, [...(by.get(g) ?? []), i]);
  const body = [
    '# Lessons: the gates ideas fail',
    '',
    [...by]
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([g, is]) =>
          `## ${g}\n${is.length} ideas. Families: ${[...new Set(is.map((i) => i.family))].map((f) => link(`families/${slug(f)}`)).join(', ')}`,
      )
      .join('\n\n') || 'No gate failures recorded.',
  ].join('\n');
  return { path: 'lessons/gates', title: 'Lessons: the gates ideas fail', body, links: linksOf(body) };
}

/** Every note: the index, one per family, one per idea, and the gate lessons. */
export function buildVault(ideas: VaultIdea[]): Note[] {
  const fams = new Map<string, VaultIdea[]>();
  for (const i of ideas) fams.set(i.family || 'unknown', [...(fams.get(i.family || 'unknown') ?? []), i]);
  const families = [...fams].map(([f, is]) => familyNote(f, is));
  const index: Note = {
    path: 'index',
    title: 'Research vault',
    body: [
      '# Research vault',
      '',
      'Start here. Read the family note before proposing in it, search for your idea, and read the ideas it links.',
      '',
      '## Families',
      [...fams]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([f, is]) => {
          const ok = is.filter((i) => OK.has(i.status)).length;
          return `- ${link(`families/${slug(f)}`)} — ${is.length} ideas, ${ok} promising or successful`;
        })
        .join('\n'),
      '',
      `## Lessons\n- ${link('lessons/gates')}`,
    ].join('\n'),
    links: [],
  };
  index.links = linksOf(index.body);
  return [index, gatesNote(ideas), ...families, ...ideas.map(ideaNote)];
}

/** The `## ` sections of a note, by heading. */
export function sections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = '';
  for (const line of body.split('\n')) {
    const m = /^## (.+)$/.exec(line);
    if (m) cur = m[1].trim();
    else if (cur) out[cur] = `${out[cur] ? `${out[cur]}\n` : ''}${line}`;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

/** Notes that match every word of `text` (title weighted), best first, with a snippet. */
export function search(notes: Note[], text: string, limit = 10) {
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  if (!words.length) return [];
  return notes
    .map((n) => {
      const t = n.title.toLowerCase();
      const b = n.body.toLowerCase();
      if (!words.every((w) => t.includes(w) || b.includes(w))) return null;
      const score = words.reduce((a, w) => a + (t.includes(w) ? 3 : 0) + (b.split(w).length - 1), 0);
      const at = Math.max(0, b.indexOf(words[0]) - 60);
      return {
        path: n.path,
        title: n.title,
        score,
        snippet: n.body.slice(at, at + 200).replace(/\n+/g, ' '),
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
