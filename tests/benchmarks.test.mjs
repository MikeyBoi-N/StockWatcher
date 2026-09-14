import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketContext, evaluateAsset } from "../js/engine.js";
import { rankPeers, relativeToSpy, strengths } from "../js/benchmarks.js";
import { grade, horizonReading } from "../js/grades.js";

const stock = (ticker, overrides = {}) => ({
  ticker, name: ticker, etf: false, sector: "Technology",
  price: 100, prevClose: 99, high52: 120, low52: 70, sma20: 99, sma50: 98, sma200: 90, rsi14: 52, hv30: 0.3,
  majorSupport: 90, secondarySupport: 80, majorResistance: 110, entrySupport: 96, return5d: 0.01, return1m: 0.02, return3m: 0.05, return6m: 0.08, return12m: 0.10,
  fundamentals: { revenueGrowthYoY: 0.05, operatingMargin: 0.15, netDebtToEbitda: 1.0, freeCashFlow: 1e9, direction: "roughly_unchanged" },
  valuation: { forwardPe: 25, trailingPe: 28, historical5yPe: 26, pegRatio: 1.8, fcfYield: 0.03 },
  catalysts: { daysToEarnings: 40, revisionsUp: 1, revisionsDown: 1, oneYearTarget: 110 },
  options: null, ...overrides
});

test("relative return compounds against SPY", () => {
  assert.equal(relativeToSpy({ return3m: 0.21 }, { return3m: 0.10 }, "return3m").toFixed(4), "0.1000");
  assert.equal(relativeToSpy({ return3m: 0.2 }, { return3m: null }, "return3m"), null);
});

test("a low-composite stock still surfaces where it leads its peers", () => {
  const peers = Array.from({ length: 9 }, (_, i) => stock(`P${i}`, { valuation: { forwardPe: 30 + i, trailingPe: 30, historical5yPe: 26, pegRatio: 2.2, fcfYield: 0.02 } }));
  const cheapLaggard = stock("LAG", {
    price: 85, sma200: 95, rsi14: 30,
    fundamentals: { revenueGrowthYoY: -0.05, operatingMargin: 0.05, netDebtToEbitda: 3, freeCashFlow: 1e9, direction: "getting_weaker" },
    valuation: { forwardPe: 9, trailingPe: 10, historical5yPe: 14, pegRatio: 0.8, fcfYield: 0.09 }
  });
  const spy = stock("SPY", { etf: true, fundamentals: null, return3m: 0.02, return12m: 0.08 });
  const records = [...peers, cheapLaggard, spy];
  const ctx = buildMarketContext(records, {});
  const evaluations = records.map(s => evaluateAsset(s, ctx));
  const ranks = rankPeers(evaluations);

  const lag = evaluations.find(e => e.item.ticker === "LAG");
  assert.ok(evaluations.filter(e => !e.item.etf).every(e => e === lag || e.overall >= lag.overall), "laggard has the lowest overall");
  const leads = strengths(ranks.get("LAG")).map(s => s.key);
  for (const key of ["fcfy", "fpe", "peg"]) assert.ok(leads.includes(key), `expected LAG to lead on ${key}`);
  assert.equal(ranks.get("LAG").get("fpe").rank, 1);
  assert.equal(ranks.get("SPY").get("fpe"), undefined, "ETFs are not ranked on company metrics");
  assert.equal(ranks.get("SPY").get("rs3m"), undefined, "SPY is not ranked against itself");
});

test("a large tie at the top does not make every tied stock a leader", () => {
  const records = Array.from({ length: 20 }, (_, i) => stock(`T${i}`));
  const ctx = buildMarketContext(records, {});
  const ranks = rankPeers(records.map(r => evaluateAsset(r, ctx)));
  assert.ok(records.every(r => ranks.get(r.ticker).get("trend").leader === false));
});

test("grades follow the scoring thresholds", () => {
  assert.equal(grade.trajectory("Getting Stronger"), "pos");
  assert.equal(grade.trajectory("Getting Weaker"), "neg");
  assert.equal(grade.revenueGrowth(0.12), "pos");
  assert.equal(grade.revenueGrowth(0.04), "warn");
  assert.equal(grade.revenueGrowth(-0.01), "neg");
  assert.equal(grade.leverage(3), "neg");
  assert.equal(grade.peg(null), "");
  assert.equal(grade.trend200(0.30), "neg");   // extended above the 200d costs points
});

test("per-period bear/bull readings come from price action and scale with volatility", () => {
  const spy = stock("SPY", { etf: true, return5d: 0.005, return1m: 0.01, return12m: 0.12, prevClose: 100, price: 100 });
  const rally = stock("UP", { price: 110, sma20: 100, return5d: 0.08, hv30: 0.25 });
  const up = horizonReading(rally, spy, "5d");
  assert.ok(up.position > 75 && up.word === "Bullish", JSON.stringify(up));
  assert.equal(up.parts.length, 3);

  const slump = stock("DOWN", { price: 90, sma50: 100, return1m: -0.12, hv30: 0.25 });
  assert.equal(horizonReading(slump, spy, "30d").word, "Bearish");

  // The same 4% week is a bigger signal for a low-volatility stock than for a volatile one.
  const calm = horizonReading(stock("CALM", { return5d: 0.04, hv30: 0.12 }), spy, "5d");
  const wild = horizonReading(stock("WILD", { return5d: 0.04, hv30: 0.80 }), spy, "5d");
  assert.ok(calm.position > wild.position);

  assert.equal(horizonReading(stock("NEW", { return12m: null }), spy, "12m"), null);
  assert.ok(horizonReading(stock("DAY", { price: 101, prevClose: 100 }), spy, "24h").position > 50);
});
