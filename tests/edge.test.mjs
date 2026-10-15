import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMarketContext, optionsPricing } from "../js/engine.js";
import { frozenModel, signalReadings } from "../js/edge.js";
import { forecastVolatility, prepare, rng } from "../js/simulator.js";

const registry = JSON.parse(readFileSync(new URL("../data/paper/registry.json", import.meta.url), "utf8"));

const spy = () => ({ ticker: "SPY", etf: true, price: 700, sma20: 695, sma50: 690, sma200: 650, return3m: 0.03, return12m: 0.12, return1m: 0.01, return5d: 0.005, hv30: 0.12 });
const qqq = () => ({ ticker: "QQQ", etf: true, price: 600, sma50: 590, sma200: 550 });
/** Twelve stocks that differ in every price signal the model reads. */
const stocks = () => Array.from({ length: 12 }, (_, k) => ({
  ticker: `S${k}`, etf: false, sector: "Technology", price: 100 + k, sma20: 99, sma50: 95 + k * 0.5, sma200: 90, rsi14: 40 + k * 2.5, hv30: 0.2 + k * 0.02,
  high52: 120, low52: 70, majorSupport: 90, entrySupport: 96, majorResistance: 125, return5d: 0.02 - k * 0.004, return1m: -0.03 + k * 0.006,
  return3m: 0.05, return12m: 0.1 + k * 0.03, volume: 1e6 + k * 1e5, avgVolume20: 1.2e6,
  fundamentals: { revenueGrowthYoY: 0.1 }, valuation: { forwardPe: 20 }, catalysts: { oneYearTarget: 150 }, options: null
}));

test("the frozen model is the newest registration's model hypothesis", () => {
  const model = frozenModel(registry);
  assert.equal(model.hypothesis, "H2");
  assert.equal(model.sessions, 21);
  assert.deepEqual(model.weights, registry.entries[0].hypotheses.find(h => h.id === "H2").weights);
  assert.equal(frozenModel({ entries: [] }), null);
});

test("signal readings rank every stock but no ETF, from prices alone", () => {
  const records = [spy(), qqq(), ...stocks()];
  const ctx = buildMarketContext(records, {});
  const model = frozenModel(registry);
  const readings = signalReadings(records, ctx, model);
  assert.equal(readings.size, 12);
  assert.ok(!readings.has("SPY"));
  const ranks = [...readings.values()].map(r => r.rank).sort((a, b) => a - b);
  assert.deepEqual(ranks, Array.from({ length: 12 }, (_, k) => k + 1));
  for (const r of readings.values()) assert.ok(Number.isFinite(r.expected) && r.percentile >= 0 && r.percentile <= 1);

  // The model was fitted without fundamentals, analyst figures or options, so they can't move its reading.
  const changed = records.map(r => r.etf ? r : { ...r, fundamentals: { revenueGrowthYoY: -0.5 }, valuation: { forwardPe: 90 }, catalysts: { oneYearTarget: 50 } });
  assert.deepEqual([...signalReadings(changed, buildMarketContext(changed, {}), model)], [...readings]);
  assert.equal(signalReadings(records.slice(0, 6), ctx, model).size, 0, "too few stocks to rank");
  assert.equal(signalReadings(records, ctx, null).size, 0);
});

/** Daily candles from a GARCH-like process: calm, then a volatile stretch at the end. */
function candles(n, { spikeAt = n - 20, seed = 3 } = {}) {
  const rand = rng(seed);
  let c = 100;
  return Array.from({ length: n }, (_, i) => {
    const vol = i >= spikeAt ? 0.04 : 0.012;
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const o = c;
    c = o * Math.exp(vol * z);
    return { t: Date.UTC(2021, 0, 1) + i * 864e5, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 1e6 };
  });
}

test("the volatility forecast starts near recent volatility and decays toward the long run", () => {
  const prep = prepare(candles(800));
  const near = forecastVolatility(prep, 5);
  const far = forecastVolatility(prep, 250);
  assert.ok(near.vol > far.vol, `after a volatile stretch the next week (${near.vol}) is above the next year (${far.vol})`);
  assert.ok(far.vol > 0.012 * Math.sqrt(252) * 0.8 && far.vol < 0.04 * Math.sqrt(252));
  assert.ok(near.persistence > 0 && near.persistence < 1);
  assert.equal(forecastVolatility(prepare(candles(100)), 21), null, "too little history to fit");
});

test("a scheduled release inside the window raises the forecast by the stock's typical earnings move", () => {
  const prep = prepare(candles(800, { spikeAt: 900 }));
  const past = [200, 263, 326, 389, 452, 515, 578, 641, 704];
  const plain = forecastVolatility(prep, 21, { past, ahead: [] });
  // Past reactions in these candles are ordinary days, so make them gaps first.
  for (const i of past) prep.rel[4 * i + 3] = 0.08;
  const withRelease = forecastVolatility(prep, 21, { past, ahead: [10] });
  assert.equal(withRelease.earningsDays, 1);
  assert.ok(withRelease.vol > plain.vol);
  assert.ok(Math.abs(withRelease.diffusive - plain.diffusive) < 0.01, "the release doesn't change the ordinary days");
});

test("options are priced against the forecast when the build has one, else against realized volatility", () => {
  const item = { options: { impliedVolatility: 0.3, ivHvRatio: 1.5 }, volForecast: { volToExpiry: 0.25 } };
  assert.equal(optionsPricing(item).basis, "forecast");
  assert.ok(Math.abs(optionsPricing(item).ratio - 1.2) < 1e-12);
  assert.equal(optionsPricing({ options: item.options }).ratio, 1.5);
  assert.equal(optionsPricing({ options: null }), null);
});
