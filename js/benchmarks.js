/**
 * Peer benchmarks: where each stock ranks among all tracked stocks on every score pillar and key metric, and how
 * it has performed against SPY. A stock with a middling composite can still lead on one measure; these ranks
 * surface that. They are for display only and never feed the Opportunity Score.
 */

import { relativeToSpy } from "./engine.js";

export { relativeToSpy };

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Metrics ranked across stocks. `get(e, spy)` returns the value or null; `higherIsBetter` sets rank order;
 * ETFs are ranked only on metrics marked `includeEtfs` (they have no fundamentals, analysts or earnings).
 */
export const PEER_METRICS = [
  { key: "quality", label: "Quality", pillar: true, get: (e) => e.scores.quality.score },
  { key: "trend", label: "Trend", pillar: true, includeEtfs: true, get: (e) => e.scores.trend.score },
  { key: "entry", label: "Entry", pillar: true, includeEtfs: true, get: (e) => e.scores.entry.score },
  { key: "trade", label: "Trade", pillar: true, includeEtfs: true, get: (e) => e.scores.trade.score },
  { key: "revg", label: "Revenue growth", get: (e) => e.item.fundamentals?.revenueGrowthYoY ?? null },
  { key: "margin", label: "Operating margin", get: (e) => e.item.fundamentals?.operatingMargin ?? null },
  { key: "lev", label: "Low leverage", higherIsBetter: false, get: (e) => e.item.fundamentals?.netDebtToEbitda ?? null },
  { key: "fcfy", label: "FCF yield", get: (e) => e.item.valuation.fcfYield },
  { key: "fpe", label: "Low forward P/E", higherIsBetter: false, get: (e) => e.item.valuation.forwardPe > 0 ? e.item.valuation.forwardPe : null },
  { key: "peg", label: "Low PEG", higherIsBetter: false, get: (e) => e.item.valuation.pegRatio > 0 ? e.item.valuation.pegRatio : null },
  {
    key: "revisions", label: "EPS revisions",
    get: (e) => isNum(e.item.catalysts.revisionsUp) && isNum(e.item.catalysts.revisionsDown) ? e.item.catalysts.revisionsUp - e.item.catalysts.revisionsDown : null
  },
  { key: "target", label: "Analyst upside", get: (e) => isNum(e.item.catalysts.oneYearTarget) ? e.item.catalysts.oneYearTarget / e.item.price - 1 : null },
  { key: "rs3m", label: "3-month return vs SPY", includeEtfs: true, get: (e, spy) => e.item.ticker === "SPY" ? null : relativeToSpy(e.item, spy, "return3m") },
  { key: "rs12m", label: "12-month return vs SPY", includeEtfs: true, get: (e, spy) => e.item.ticker === "SPY" ? null : relativeToSpy(e.item, spy, "return12m") }
];

/**
 * How many top ranks count as leading: the top 10% of ranked stocks, and at least the top 3. A tie only leads
 * when the tied group ends within twice that cutoff, so ten stocks sharing the best pillar score don't all "lead".
 */
export const leaderCutoff = (count) => Math.max(3, Math.ceil(count * 0.1));

/**
 * @param {object[]} evaluations every tracked stock's evaluateAsset() result
 * @returns {Map<string, Map<string, {rank: number, of: number, leader: boolean}>>} ticker -> metric key -> rank
 *   (competition ranking: ties share a rank; metrics need at least 5 stocks with data to rank)
 */
export function rankPeers(evaluations) {
  const spy = evaluations.find(e => e.item.ticker === "SPY")?.item;
  const ranks = new Map(evaluations.map(e => [e.item.ticker, new Map()]));
  for (const metric of PEER_METRICS) {
    const higherIsBetter = metric.higherIsBetter !== false;
    const values = evaluations
      .filter(e => metric.includeEtfs || !e.item.etf)
      .map(e => ({ ticker: e.item.ticker, value: metric.get(e, spy) }))
      .filter(v => isNum(v.value))
      .sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);
    if (values.length < 5) continue;
    const cutoff = leaderCutoff(values.length);
    const rankOf = [];
    values.forEach((v, i) => { rankOf[i] = i > 0 && v.value === values[i - 1].value ? rankOf[i - 1] : i + 1; });
    values.forEach((v, i) => {
      const tiedThrough = rankOf.lastIndexOf(rankOf[i]) + 1;
      ranks.get(v.ticker).set(metric.key, { rank: rankOf[i], of: values.length, leader: rankOf[i] <= cutoff && tiedThrough <= cutoff * 2 });
    });
  }
  return ranks;
}

/** Leading measures for one stock, best rank first: [{key, label, rank, of}]. */
export function strengths(tickerRanks) {
  if (!tickerRanks) return [];
  return PEER_METRICS
    .map(m => ({ key: m.key, label: m.label, ...tickerRanks.get(m.key) }))
    .filter(s => s.leader)
    .sort((a, b) => a.rank - b.rank);
}
