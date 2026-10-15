/**
 * Signals that rank stocks against each other, in the form the Strategy needs.
 *
 * The paper record (js/paper.js) freezes a fitted model at registration (hypothesis H2): weights on within-week ranks
 * of the engine's price-based scores and known price signals, fitted to each stock's return over its benchmark for the
 * next month, demeaned within the week. signalReadings() scores today's tracked stocks with those frozen weights,
 * exactly as the model was fitted: Trend, Entry and Trade are recomputed from prices alone (no fundamentals, analyst
 * figures or options, which the replay can't rebuild), and every signal is ranked across the stocks.
 *
 * The result is the model's expected return for each stock relative to the others, not a forecast of the market. Its
 * evidence is whatever the paper record says about H2; the page and the API say so next to it.
 */
import { evaluateAsset } from "./engine.js";
import { SIGNALS, rankScores } from "./signals.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** Fewer stocks than this and a rank says little about where a stock stands. */
const MIN_STOCKS = 8;

/**
 * The newest registration's frozen model: { label, registeredOn, hypothesis, weights, sessions, benchmark }, or null
 * when nothing with a model is registered.
 */
export function frozenModel(registry) {
  const entries = [...(registry?.entries ?? [])].sort((a, b) => b.registeredOn.localeCompare(a.registeredOn));
  for (const spec of entries) {
    const h = spec.hypotheses?.find(x => x.kind === "model");
    if (h) return { label: `${h.id}, registered ${spec.registeredOn}`, registeredOn: spec.registeredOn, hypothesis: h.id, weights: h.weights, sessions: h.sessions, benchmark: h.benchmark };
  }
  return null;
}

/**
 * Today's model reading for each tracked stock (ETFs are left out, as in the fit).
 * @param records market records (data/market.json stocks, after any stress test)
 * @param context buildMarketContext() of the same records
 * @param model frozenModel()
 * @returns Map ticker -> { expected, rank, of, percentile } where `expected` is the predicted return over the model's
 *   benchmark for its `sessions`, relative to the other stocks, and percentile runs 0 (lowest) to 1 (highest).
 */
export function signalReadings(records, context, model) {
  const out = new Map();
  if (!model) return out;
  const stocks = records.filter(r => !r.etf && isNum(r.price));
  if (stocks.length < MIN_STOCKS) return out;
  const states = stocks.map(r => {
    const e = evaluateAsset({ ...r, fundamentals: null, valuation: null, catalysts: {}, options: null }, context);
    return { overall: e.overall, trend: e.scores.trend.score, entry: e.scores.entry.score, trade: e.scores.trade.score, inputs: r };
  });
  const ranks = Object.fromEntries(SIGNALS.map(sig => [sig.key, rankScores(states.map(s => {
    const v = sig.value(s);
    return isNum(v) ? v : null;
  }))]));
  const expected = states.map((_, k) => Object.entries(model.weights).reduce((sum, [key, w]) => sum + w * (ranks[key]?.[k] ?? 0), 0));
  if (!expected.every(isNum)) throw new Error("Signal model produced a non-finite score; check the frozen weights");
  const order = expected.map((v, k) => [v, k]).sort((a, b) => b[0] - a[0]);
  order.forEach(([v, k], position) => {
    out.set(stocks[k].ticker, { expected: v, rank: position + 1, of: stocks.length, percentile: stocks.length > 1 ? 1 - position / (stocks.length - 1) : 0.5 });
  });
  return out;
}
