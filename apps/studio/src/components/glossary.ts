// #283: plain-language meanings of the jargon on KPI cards and table headers, shown as a tooltip wherever the term is
// a label. Keys are matched case-insensitively against the whole label.

const TERMS: Record<string, string> = {
  cagr: 'Compound annual growth rate: the yearly return that, compounded, gives the total return over the period.',
  sharpe:
    'Return per unit of risk: the average daily excess return over the risk-free rate divided by its volatility, scaled to a year. Above 1 is strong for a stock strategy.',
  'deflated sharpe':
    'The chance that the true Sharpe is above zero after accounting for how many strategies were tried (each evaluation is a trial). Many tries make a high Sharpe easier to find by luck, so this goes down as trials go up.',
  'max drawdown': 'The largest fall from a previous peak of the equity curve, before it recovered.',
  'max dd': 'The largest fall from a previous peak of the equity curve, before it recovered.',
  'excess vs s&p 500':
    'How much more (or less) a year the strategy earned than the S&P 500 total return (SPY with dividends) over the same days.',
  'excess / year':
    'How much more (or less) a year the strategy earned than the S&P 500 total return (SPY with dividends) over the same days.',
  'median excess': 'The middle excess return over the S&P 500 across the ideas in this group.',
  'median sharpe': 'The middle Sharpe across the ideas in this group.',
  'hit rate': 'The share of days (or trades) with a positive return.',
  holdout:
    'The last stretch of data that the research never sees. A strategy that passes exploration gets one run on it, once: that is the out-of-sample test.',
  'total trials':
    'Every evaluation counts as a trial. The more strategies are tried, the higher a Sharpe has to be to be believed (see Deflated Sharpe).',
  trial:
    'This evaluation’s number among all evaluations in the workspace; the deflated Sharpe uses the count.',
  'final nav': 'The simulated book’s value at the end, after costs, borrow and dividends.',
  'yield / 100': 'Promising or successful verdicts per 100 ideas proposed.',
  'code attempts': 'How many code versions the Coder wrote per idea before it ran or was given up.',
  promising: 'Beat the S&P 500 but did not pass every gate: worth a look, not proven.',
  successful: 'Passed every gate, including the one-shot holdout.',
  'forward only':
    'An idea whose data has too little history to backtest: it is tracked from today on (paper), not evaluated on the past.',
  'in flight': 'Ideas between proposal and verdict: in review, being coded or being evaluated.',
  turnover: 'How much of the book is traded at each rebalance (100% = the whole book replaced once).',
  'walk-forward folds':
    'The same run split by calendar year, to see whether the result holds in each year or comes from one.',
  'factor exposures':
    'How much of the return moves with the market (and other factors, when available); alpha is what is left, with its t-statistic.',
};

/** The meaning of a label, if it is a known term (for a `title` tooltip). */
export function termOf(label: unknown): string | undefined {
  return typeof label === 'string' ? TERMS[label.trim().toLowerCase()] : undefined;
}
