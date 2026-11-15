/** The scope of an evaluation (#366): a symbol list, the top N by market cap on each date, or the whole universe. */
export function scopeLabel(p: { symbols?: string[]; universe?: { top_by_market_cap?: number } }) {
  if (p.symbols?.length) return `${p.symbols.length} symbols`;
  const top = p.universe?.top_by_market_cap;
  if (top) return top === 500 ? 'S&P 500 proxy (top 500 by market cap)' : `top ${top} by market cap`;
  return 'whole universe';
}
