// The spend cap (#297): model calls priced per model from model_usage, checked before every model call in the
// workspace. At a cap the call is refused, the run stops, and the research loop pauses itself (schedule off) with
// the reason recorded, so an unattended experiment can never spend past what the owner set.
import { collection } from './db.js';
import { HttpError } from './security.js';
import { researchSettings, updateResearchSettings } from './researchLoop.js';

/** USD per 1M tokens (output includes thinking). Google's pricing page, 2026-11-06; prices double on 2027-01-01. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};
/** A model missing from the table is priced high, so a cap errs on the safe side. */
export const UNKNOWN_PRICE = { input: 3, output: 15 };

type Prices = Record<string, { input: number; output: number }>;
export function priceOf(model: string, overrides: Prices = {}, flat?: number) {
  const key = String(model ?? '').toLowerCase();
  return (
    overrides[model] ??
    overrides[key] ??
    MODEL_PRICES[key] ??
    (flat !== undefined ? { input: flat, output: flat } : UNKNOWN_PRICE)
  );
}
export const usdOf = (input: number, output: number, p: { input: number; output: number }) =>
  (input / 1e6) * p.input + (output / 1e6) * p.output;

/** Spend since a date: total USD, tokens and calls, by model. */
export async function spendSince(
  ownerId: string,
  since: Date | undefined,
  prices: Prices = {},
  flat?: number,
) {
  const rows = await collection('model_usage')
    .aggregate<{ _id: string; input: number; output: number; calls: number }>([
      { $match: { ownerId, ...(since ? { at: { $gte: since } } : {}) } },
      {
        $group: { _id: '$model', input: { $sum: '$input' }, output: { $sum: '$output' }, calls: { $sum: 1 } },
      },
    ])
    .toArray();
  const byModel = rows.map((r) => ({
    model: r._id,
    calls: r.calls,
    input: r.input,
    output: r.output,
    usd: usdOf(r.input, r.output, priceOf(r._id, prices, flat)),
  }));
  return {
    usd: byModel.reduce((a, m) => a + m.usd, 0),
    input: byModel.reduce((a, m) => a + m.input, 0),
    output: byModel.reduce((a, m) => a + m.output, 0),
    calls: byModel.reduce((a, m) => a + m.calls, 0),
    byModel,
  };
}

const startOfUtcDay = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
/** The spend against the caps; `exceeded` names the cap that was reached. */
export async function budgetState(ownerId: string, now = new Date()) {
  const s = await researchSettings(ownerId);
  const b = s.budget ?? {};
  const prices = (b.prices ?? {}) as Prices;
  const today = await spendSince(ownerId, startOfUtcDay(now), prices, b.usdPerMillionTokens);
  const total =
    b.capUsd !== undefined ? await spendSince(ownerId, b.capSince, prices, b.usdPerMillionTokens) : undefined;
  const exceeded =
    b.dailyCapUsd !== undefined && today.usd >= b.dailyCapUsd
      ? `today's spend $${today.usd.toFixed(2)} reached the daily cap of $${b.dailyCapUsd.toFixed(2)}`
      : total && b.capUsd !== undefined && total.usd >= b.capUsd
        ? `the spend since ${b.capSince ? new Date(b.capSince).toISOString().slice(0, 16).replace('T', ' ') : 'the start'} ($${total.usd.toFixed(2)}) reached the cap of $${b.capUsd.toFixed(2)}`
        : undefined;
  return {
    today: today.usd,
    todayTokens: { input: today.input, output: today.output, calls: today.calls },
    ...(total
      ? {
          sinceCap: total.usd,
          sinceCapTokens: { input: total.input, output: total.output, calls: total.calls },
        }
      : {}),
    capUsd: b.capUsd,
    capSince: b.capSince,
    dailyCapUsd: b.dailyCapUsd,
    byModelToday: today.byModel,
    ...(exceeded ? { exceeded } : {}),
    ...(b.stoppedAt ? { stoppedAt: b.stoppedAt, stopReason: b.stopReason } : {}),
  };
}

const CACHE_MS = 20_000;
/** The spend decision, cached per owner and budget setting: a changed cap takes effect at the next call. */
const cache = new Map<string, { at: number; key: string; exceeded?: string }>();
/** Throws before a model call when a cap is reached; pauses the research loop the first time. */
export async function assertWithinBudget(ownerId: string) {
  const s = await researchSettings(ownerId);
  const b = s.budget ?? {};
  if (b.capUsd === undefined && b.dailyCapUsd === undefined) return;
  const key = JSON.stringify([b.capUsd, b.capSince, b.dailyCapUsd, b.prices, b.usdPerMillionTokens]);
  const hit = cache.get(ownerId);
  let exceeded = hit?.exceeded;
  if (!hit || hit.key !== key || Date.now() - hit.at >= CACHE_MS) {
    exceeded = (await budgetState(ownerId)).exceeded;
    cache.set(ownerId, { at: Date.now(), key, ...(exceeded ? { exceeded } : {}) });
    if (exceeded && !b.stoppedAt) await stopResearch(ownerId, exceeded);
  }
  if (exceeded)
    throw new HttpError(
      402,
      `Spend cap reached: ${exceeded}. Raise the cap in Research settings to continue.`,
    );
}
/** Forget the cached decision. */
export const resetBudgetCache = (ownerId?: string) => (ownerId ? cache.delete(ownerId) : cache.clear());

async function stopResearch(ownerId: string, reason: string) {
  const s = await researchSettings(ownerId);
  await updateResearchSettings(ownerId, {
    paused: true,
    budget: { ...(s.budget ?? {}), stoppedAt: new Date(), stopReason: reason },
  });
  // The research harness's schedule goes off, like Pause in the Research Lab.
  await collection<any>('workflows').updateOne(
    { ownerId, name: 'Research loop', schedule: { $exists: true } },
    { $set: { 'schedule.enabled': false, updatedAt: new Date() } },
  );
  console.warn(`research loop paused for ${ownerId}: ${reason}`);
}
