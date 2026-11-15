// Instrument types (#393): tell common stock and ADRs from notes, preferreds, warrants, units, rights and funds.
// FMP lists exchange-traded debt, preferreds and SPAC warrants next to common stock, often under the issuer's name
// and market cap ("DTE Energy Company 2020 Series", "The Southern Company JR 2017B NT 77"). Only `common` and
// `ADR` are equity for the universes. The same rules are in pipeline/core/instruments.py; both are tested against
// tests/fixtures/instrument-types.json.
export type InstrumentType =
  'common' | 'ADR' | 'preferred' | 'note' | 'warrant' | 'unit' | 'right' | 'fund' | 'etf';
export const EQUITY_TYPES: readonly InstrumentType[] = ['common', 'ADR'];

const PREFERRED_SYMBOL = /[-.](P[A-Z]?|PR[A-Z]?)$/;
const PREFERRED_NAME = /\b(preferred|pfd|perpetual)\b/;
const ADR_NAME = /\bamerican depositary (shares?|receipts?)\b/;
const WARRANT_SYMBOL = /[-.](WS|W[A-Z]?)$|^[A-Z]{4}W$/;
const UNIT_SYMBOL = /[-.](U|UN)$|^[A-Z]{4}U$/;
const RIGHT_SYMBOL = /[-.](R|RT)$|^[A-Z]{4}R$/;
const NOTE_NAME = [
  /\b(notes?|debentures?|nt)\b/,
  /\bdue (19|20)\d{2}\b/,
  /\d+(\.\d+)?\s?%/,
  /\b(19|20)\d{2}[a-z]?\s+series\b/,
  /\b(subordinated|fixed[- ]rate|floating[- ]rate)\b/,
];

export type InstrumentFlags = { isEtf?: boolean; isFund?: boolean; isAdr?: boolean };

export function instrumentType(
  symbol: string,
  name?: string | null,
  flags: InstrumentFlags = {},
): InstrumentType {
  const s = String(symbol ?? '').toUpperCase();
  const n = String(name ?? '').toLowerCase();
  if (flags.isEtf) return 'etf';
  if (flags.isFund) return 'fund';
  if (ADR_NAME.test(n)) return 'ADR';
  if (PREFERRED_SYMBOL.test(s) || PREFERRED_NAME.test(n)) return 'preferred';
  if (WARRANT_SYMBOL.test(s) || /\bwarrants?\b/.test(n)) return 'warrant';
  if (UNIT_SYMBOL.test(s)) return 'unit';
  if (RIGHT_SYMBOL.test(s)) return 'right';
  if (NOTE_NAME.some((p) => p.test(n))) return 'note';
  return flags.isAdr ? 'ADR' : 'common';
}

export const isEquity = (symbol: string, name?: string | null, flags: InstrumentFlags = {}) =>
  EQUITY_TYPES.includes(instrumentType(symbol, name, flags));
