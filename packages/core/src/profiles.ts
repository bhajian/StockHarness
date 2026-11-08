// Idea profiles (#323): what an idea trades and how. Equity ideas hold stocks long, short or both; options
// ideas name a structure (covered call, cash-secured put, …), built by platform code once the options
// evaluator exists (#329). Mirrored for agents in the Theorist's brief and the profile skills (#331).
export const INSTRUMENTS = ['equity', 'options'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

/** Options structures (#328): their family, the market view they express, and whether they sell volatility. */
export const OPTION_STRUCTURES = {
  covered_call: { label: 'Covered call', group: 'income', direction: 'long', shortVol: true },
  cash_secured_put: { label: 'Cash-secured put', group: 'income', direction: 'long', shortVol: true },
  wheel: { label: 'The wheel (put, then covered call)', group: 'income', direction: 'long', shortVol: true },
  long_call: { label: 'Long call', group: 'directional', direction: 'long', shortVol: false },
  long_put: { label: 'Long put', group: 'directional', direction: 'short', shortVol: false },
  bull_call_spread: { label: 'Bull call spread', group: 'directional', direction: 'long', shortVol: false },
  bear_put_spread: { label: 'Bear put spread', group: 'directional', direction: 'short', shortVol: false },
  bull_put_spread: {
    label: 'Bull put (credit) spread',
    group: 'directional',
    direction: 'long',
    shortVol: true,
  },
  bear_call_spread: {
    label: 'Bear call (credit) spread',
    group: 'directional',
    direction: 'short',
    shortVol: true,
  },
  protective_put: { label: 'Protective put', group: 'hedge', direction: 'long', shortVol: false },
  collar: { label: 'Collar', group: 'hedge', direction: 'long', shortVol: false },
  long_straddle: { label: 'Long straddle', group: 'volatility', direction: 'neutral', shortVol: false },
  long_strangle: { label: 'Long strangle', group: 'volatility', direction: 'neutral', shortVol: false },
  short_strangle: { label: 'Short strangle', group: 'volatility', direction: 'neutral', shortVol: true },
  iron_condor: { label: 'Iron condor', group: 'volatility', direction: 'neutral', shortVol: true },
} as const;
export type OptionStructure = keyof typeof OPTION_STRUCTURES;
export const STRUCTURE_IDS = Object.keys(OPTION_STRUCTURES) as [OptionStructure, ...OptionStructure[]];

/** The options evaluator (#329) is not there yet: options ideas can be described, not submitted for a test. */
export const OPTIONS_EVALUATOR_READY = false;

const EQUITY = {
  equity_long: { label: 'Equity · long', instrument: 'equity', direction: 'long' },
  equity_short: { label: 'Equity · short', instrument: 'equity', direction: 'short' },
  equity_long_short: { label: 'Equity · long / short', instrument: 'equity', direction: 'long_short' },
} as const;
export type ProfileId = keyof typeof EQUITY | `options_${OptionStructure}`;
export const PROFILE_IDS = [
  ...(Object.keys(EQUITY) as (keyof typeof EQUITY)[]),
  ...STRUCTURE_IDS.map((s) => `options_${s}` as const),
] as [ProfileId, ...ProfileId[]];

export type Profile = {
  id: ProfileId;
  label: string;
  instrument: Instrument;
  direction: 'long' | 'short' | 'long_short' | 'neutral';
  structure?: OptionStructure;
  group?: string;
  /** False while the evaluator cannot test it (options until #329). */
  available: boolean;
};
export function profileOf(id: ProfileId): Profile {
  if (id in EQUITY) {
    const e = EQUITY[id as keyof typeof EQUITY];
    return { id, label: e.label, instrument: 'equity', direction: e.direction, available: true };
  }
  const structure = id.slice('options_'.length) as OptionStructure;
  const o = OPTION_STRUCTURES[structure];
  return {
    id,
    label: `Options · ${o.label.toLowerCase()}`,
    instrument: 'options',
    direction: o.direction,
    structure,
    group: o.group,
    available: OPTIONS_EVALUATOR_READY,
  };
}
export const ALL_PROFILES = PROFILE_IDS.map(profileOf);

/** A theory's profile id from its fields (old theories have no instrument: equity). */
export function theoryProfileId(t: {
  instrument?: Instrument;
  structure?: OptionStructure;
  direction?: string;
}) {
  if (t.instrument === 'options' && t.structure) return `options_${t.structure}` as ProfileId;
  return (
    t.direction === 'short'
      ? 'equity_short'
      : t.direction === 'long_short'
        ? 'equity_long_short'
        : 'equity_long'
  ) as ProfileId;
}

/** Problems with a theory's instrument / structure / direction, as messages (empty when it is consistent). */
export function profileProblems(t: { instrument?: string; structure?: string; direction?: string }) {
  const out: string[] = [];
  if (t.instrument === 'options') {
    if (!t.structure) out.push(`an options idea names its structure (one of ${STRUCTURE_IDS.join(', ')})`);
  } else {
    if (t.structure) out.push('structure is for options ideas (instrument: options)');
    if (t.direction === 'neutral')
      out.push('neutral is for options ideas; an equity idea is long, short or long_short');
  }
  return out;
}
