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

const READINGS = [
  { min: 90, word: "Exceptional" },
  { min: 80, word: "Strong" },
  { min: RULES.actionableScore, word: "Bullish" },
  { min: RULES.avoidScore, word: "Neutral" },
  { min: 40, word: "Weak" },
  { min: 0, word: "Bearish" }
];

/** Position (0-100) and one word for the bear/bull meter, from the Opportunity Score and the verdict thresholds. */
export function bullBearReading(totalScore) {
  const position = Math.max(0, Math.min(100, totalScore));
  return { position, word: READINGS.find(r => position >= r.min).word };
}
