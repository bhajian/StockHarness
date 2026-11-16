// Every successful or promising idea gets a simulation: 10 years to the latest price (or from the earliest start the
// data allows), $1M, labelled with the idea's verdict. Owner request (2026-11-17): "for any promising idea, force the
// simulation to run which shows 10 years till today even if all of the gates were not succeeded".
import { collection } from './db.js';
import { earliestPriceDate, latestPriceDate } from './evaluations.js';
import { safeError } from './security.js';
import { simulations, startSimulation } from './simulations.js';
import { theories, type Theory } from './theories.js';

export const AUTO_YEARS = 10;
const addYears = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

/** The period: 10 years to the latest price, no earlier than a year after the first price (lookbacks need it). */
export async function autoPeriod(ownerId: string) {
  const end = await latestPriceDate(ownerId);
  const first = await earliestPriceDate(ownerId);
  if (!end) return undefined;
  // A year after the first price, so every 12-month lookback has data; with less than a year, the first price.
  const year = first ? addYears(first, 1) : undefined;
  const floor = year && year < end ? year : first;
  const wanted = addYears(end, -AUTO_YEARS);
  return { start: floor && wanted < floor ? floor : wanted, end, allowHoldout: true };
}

/** Start the automatic simulation of one idea, unless it already has one for its current code version. */
export async function autoSimulateIdea(
  ownerId: string,
  t: Pick<Theory, 'number' | 'title' | 'status' | 'plugin'>,
) {
  const label =
    t.status === 'successful' || t.status === 'approved'
      ? 'successful'
      : t.status === 'promising'
        ? 'promising'
        : undefined;
  if (!label || !t.plugin) return { skipped: 'not promising or successful, or no code' };
  const ref = `T-${t.number}`;
  const version = t.plugin.versions.at(-1);
  const done = await simulations().findOne({
    ownerId,
    'config.auto': true,
    'config.ideas.idea': ref,
    ...(version ? { 'config.ideas.version': version } : {}),
    status: { $in: ['running', 'succeeded'] },
  } as Record<string, unknown>);
  if (done) return { skipped: 'already simulated', simulation_id: done._id };
  const period = await autoPeriod(ownerId);
  if (!period) return { skipped: 'no prices' };
  const sim = await startSimulation(ownerId, {
    name: `${ref} ${t.title}`.slice(0, 110) + ` (${label})`,
    description: `Automatic simulation of a ${label} idea: ${period.start} → ${period.end}, $1M, the research scope.`,
    label,
    auto: true,
    ideas: [{ idea: ref }],
    period,
    capital: 1_000_000,
  });
  return { started: sim.simulation._id, label, period };
}

/** Fire and forget after a verdict: a failure here never changes the verdict. */
export function autoSimulateAfterVerdict(ownerId: string, t: Theory) {
  void autoSimulateIdea(ownerId, t).catch((e) =>
    console.warn(`Automatic simulation of T-${t.number} did not start:`, safeError(e)),
  );
}

/** Every promising or successful idea without its automatic simulation, oldest first (for a one-off backfill). */
export async function ideasToAutoSimulate(ownerId: string) {
  const rows = await theories()
    .find(
      { ownerId, status: { $in: ['promising', 'successful', 'approved'] } },
      { projection: { number: 1, title: 1, status: 1, plugin: 1 } },
    )
    .sort({ number: 1 })
    .toArray();
  const out = [];
  for (const t of rows) {
    const has = await collection('simulations').findOne(
      { ownerId, 'config.auto': true, 'config.ideas.idea': `T-${t.number}` } as Record<string, unknown>,
      { projection: { _id: 1 } },
    );
    if (!has && t.plugin) out.push(t);
  }
  return out;
}
