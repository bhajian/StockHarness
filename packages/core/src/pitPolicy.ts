// Point-in-time read policy per collection (#103, #108, #148), derived from the Schema Catalog (#84). The
// strategy reader (pipeline/strategy/reader.py), the agent data tools and collection bindings all apply it:
// Layer 2 rows by their `as_of_date`, Layer 1 rows by their known-at rule, static data uncut, and current-only
// or undocumented collections refused for historical dates. `coarseFilter` is a MongoDB pre-filter that never
// drops a visible row; `visibleAt` is the exact test (pipeline/strategy/known_at.py mirrors both).
import { knownAtOf, type KnownAtRule } from './knownAt.js';
import { listCatalog, type CatalogEntry } from './schemaCatalog.js';

export type PitPolicy =
  { mode: 'pit'; rule: KnownAtRule } | { mode: 'static' } | { mode: 'refuse'; reason: string };

export function policyOf(e: Pick<CatalogEntry, 'layer' | 'timeSemantics'>): PitPolicy {
  const t = e.timeSemantics;
  if (t.status === 'static') return { mode: 'static' };
  if (t.status === 'current_only')
    return { mode: 'refuse', reason: 'it holds current values only (no history)' };
  if (t.status !== 'pit')
    return { mode: 'refuse', reason: 'no producer declares when its rows became known' };
  if (t.rule) return { mode: 'pit', rule: t.rule };
  // Layer 2 outputs: their as_of field, or a known_at timestamp (usable from the next session).
  const field = t.eventDate ?? 'as_of_date';
  if (field === 'as_of_date') return { mode: 'pit', rule: { type: 'asOf', field } };
  if (field === 'known_at') return { mode: 'pit', rule: { type: 'timestamp', field } };
  return { mode: 'pit', rule: { type: 'eod', field } };
}

/** Policies for every catalogued collection of a workspace. */
export async function pitPolicies(ownerId: string): Promise<Record<string, PitPolicy>> {
  const out: Record<string, PitPolicy> = {};
  for (const e of await listCatalog(ownerId)) out[e.collection] = policyOf(e);
  return out;
}

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const le = (field: string, d: string) => ({
  $or: [
    { [field]: { $lte: `${d}~` } },
    { [field]: { $type: 'date', $lte: new Date(`${addDays(d, 2)}T00:00:00Z`) } },
  ],
});

/** A MongoDB pre-filter keeping every row visible on `d` (and maybe a few more). */
export function coarseFilter(rule: KnownAtRule, d: string): Record<string, unknown> {
  switch (rule.type) {
    case 'asOf':
      return { [rule.field]: { $lte: d } };
    case 'eod':
    case 'snapshot':
    case 'nextSession':
      return le(rule.field, d);
    case 'timestamp':
      return rule.fallback ? { $or: [le(rule.field, d), le(rule.fallback, d)] } : le(rule.field, d);
    case 'dayBefore':
      return le(rule.field, addDays(d, 1));
    case 'statement':
      return le('date', d);
    case 'periodLag':
      return le(rule.periodField, d);
    case 'current_only':
      return { _id: { $exists: false } };
  }
}

/** Fields a rule reads (fetch them even when the caller projects other columns). */
export function ruleFields(rule: KnownAtRule): string[] {
  if (rule.type === 'statement') return ['acceptedDate', 'date', 'period'];
  if (rule.type === 'periodLag') return [rule.periodField];
  if (rule.type === 'current_only') return [];
  return [rule.field, ...(rule.type === 'timestamp' && rule.fallback ? [rule.fallback] : [])];
}

/** The exact point-in-time test: the row's first usable date is on or before `d`. */
export function visibleAt(rule: KnownAtRule, row: Record<string, unknown>, d: string) {
  const r = knownAtOf(rule, row);
  return !!r && r.as_of_date <= d;
}
