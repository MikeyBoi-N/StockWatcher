/**
 * Green / yellow / red grades for individual metrics, using the same thresholds as the scoring engine
 * (js/engine.js): "pos" earns points, "neg" costs points, "warn" is in between. Metrics the score doesn't use
 * directly (earnings growth, margin change) follow the business-trajectory votes in scripts/market_data/fundamentals.py.
 * An empty string means no grade (missing data or no direction).
 */
import { RULES } from "./engine.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const band = (v, { pos, neg, higherIsBetter = true }) => {
  if (!isNum(v)) return "";
  if (higherIsBetter) return v >= pos ? "pos" : v < neg ? "neg" : "warn";
  return v <= pos ? "pos" : v > neg ? "neg" : "warn";
};

export const grade = {
  revenueGrowth: (v) => band(v, { pos: 0.10, neg: 0 }),
  earningsGrowth: (v) => isNum(v) ? (v > 0.10 ? "pos" : v < 0 ? "neg" : "warn") : "",
  operatingMargin: (v) => band(v, { pos: 0.30, neg: 0.08 }),
  marginChange: (v) => isNum(v) ? (v >= 0.01 ? "pos" : v <= -0.01 ? "neg" : "warn") : "",
  freeCashFlow: (v) => isNum(v) ? (v < 0 ? "neg" : "pos") : "",
  fcfTrend: (t) => ({ growing: "pos", stable: "warn", shrinking: "neg" })[t] ?? "",
  leverage: (v) => band(v, { pos: 0.5, neg: 2.5, higherIsBetter: false }),
  trajectory: (a) => ({ "Getting Stronger": "pos", "Roughly Unchanged": "warn", "Getting Weaker": "neg" })[a] ?? "",
  valuation: (a) => ({ attractive: "pos", fair: "warn", stretched: "neg" })[a] ?? "",
  forwardPe: (v) => isNum(v) ? (v > RULES.extremePe || v <= 0 ? "neg" : v > RULES.richPe ? "warn" : "") : "",
  peg: (v) => isNum(v) ? (v <= 1.2 ? "pos" : v > 2.0 ? "neg" : "warn") : "",
  fcfYield: (v) => band(v, { pos: 0.05, neg: 0.02 }),
  trend200: (dist) => isNum(dist) ? (dist > RULES.extendedAbove200 ? "neg" : dist > 0 ? "pos" : "neg") : "",
  trend50: (dist) => isNum(dist) ? (dist > RULES.extendedAbove50 ? "neg" : "") : "",
  rsi: (v) => isNum(v) ? (v > 68 ? "neg" : v < 38 ? "warn" : "") : "",
  earningsDays: (d) => isNum(d) ? (d <= RULES.earningsWarningDays ? "neg" : "") : "",
  revisions: (up, down) => isNum(up) && isNum(down) ? (up - down >= 2 ? "pos" : up - down <= -2 ? "neg" : "warn") : "",
  targetUpside: (v) => isNum(v) ? (v > 0.15 ? "pos" : v < -0.05 ? "neg" : "warn") : "",
  ivRatio: (v) => isNum(v) ? (v <= RULES.ivCheapRatio ? "pos" : v >= RULES.ivExpensiveRatio ? "neg" : "warn") : "",
  openInterest: (v) => isNum(v) ? (v < RULES.minOpenInterest ? "neg" : "") : "",
  spreadPct: (v) => isNum(v) ? (v > RULES.maxSpreadPct ? "neg" : "") : ""
};

export const HORIZONS = [
  { key: "24h", label: "24 hours", days: 1, returnOf: (i) => isNum(i.prevClose) && i.prevClose > 0 ? i.price / i.prevClose - 1 : null, spyReturnOf: (s) => isNum(s?.prevClose) && s.prevClose > 0 ? s.price / s.prevClose - 1 : null, line: null },
  { key: "5d", label: "5 days", days: 5, field: "return5d", line: ["sma20", "20-day SMA"] },
  { key: "30d", label: "30 days", days: 21, field: "return1m", line: ["sma50", "50-day SMA"] },
  { key: "6m", label: "6 months", days: 126, field: "return6m", line: ["sma200", "200-day SMA"] },
  { key: "12m", label: "12 months", days: 252, field: "return12m", line: ["sma200", "200-day SMA"] }
];

const WORDS = [[75, "Bullish"], [58, "Firm"], [42, "Neutral"], [25, "Weak"], [-Infinity, "Bearish"]];

/** The bear/bull word for a 0-100 position, so a stored average and a live reading always read the same way. */
export const bullWord = (position) => WORDS.find(([min]) => position >= min)[1];

/**
 * Backward-looking bear/bull reading for one period, from price action only:
 *   50% the period's return in units of the stock's own typical move for that period (30-day realized volatility),
 *   30% the return relative to SPY in the same units, 20% where price sits against the trend line for that period.
 * Each part is capped at +/-2.5 typical moves; weights of missing parts are redistributed.
 * @returns {{position: number, word: string, parts: string[]} | null} position 0 (bearish) to 100 (bullish), or null without the period's return
 */
export function horizonReading(item, spy, horizonKey) {
  const h = HORIZONS.find(x => x.key === horizonKey);
  const r = h.returnOf ? h.returnOf(item) : item[h.field];
  if (!isNum(r) || r <= -1) return null;
  const vol = isNum(item.hv30) && item.hv30 > 0 ? item.hv30 : 0.3;
  const sigma = Math.max(0.005, vol * Math.sqrt(h.days / 252));
  const capped = (z) => Math.max(-2.5, Math.min(2.5, z)) / 2.5;
  const signedPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`;

  const parts = [];
  const components = [];
  const z = Math.log(1 + r) / sigma;
  components.push([0.5, capped(z)]);
  parts.push(`${signedPct(r)} return (${z >= 0 ? "+" : "−"}${Math.abs(z).toFixed(1)} typical moves)`);

  const s = h.spyReturnOf ? h.spyReturnOf(spy) : spy?.[h.field];
  if (item.ticker !== "SPY" && isNum(s) && s > -1) {
    const rel = (1 + r) / (1 + s) - 1;
    components.push([0.3, capped(Math.log(1 + rel) / sigma)]);
    parts.push(`${signedPct(rel)} vs SPY`);
  }
  if (h.line && isNum(item[h.line[0]]) && item[h.line[0]] > 0) {
    const dist = item.price / item[h.line[0]] - 1;
    components.push([0.2, capped(Math.log(1 + dist) / sigma)]);
    parts.push(`${Math.abs(dist * 100).toFixed(1)}% ${dist >= 0 ? "above" : "below"} the ${h.line[1]}`);
  }
  const weight = components.reduce((sum, [w]) => sum + w, 0);
  const blended = components.reduce((sum, [w, v]) => sum + w * v, 0) / weight;
  const position = Math.round(50 + 50 * blended);
  return { position, word: bullWord(position), parts };
}
