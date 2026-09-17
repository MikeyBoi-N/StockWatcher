import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketContext, evaluateAsset } from "../js/engine.js";
import { bullWord } from "../js/grades.js";
import { foldDay, foldSample, historyRows, marketDay, metricCell, sampleFromEvaluation, snapshotFromEvaluations } from "../js/history.js";

const stock = (ticker, overrides = {}) => ({
  ticker, name: ticker, etf: false, sector: "Technology",
  price: 100, prevClose: 99, high52: 120, low52: 70, sma20: 99, sma50: 98, sma200: 90, rsi14: 52, hv30: 0.3,
  majorSupport: 90, secondarySupport: 80, majorResistance: 110, entrySupport: 96, return5d: 0.01, return1m: 0.02, return3m: 0.05, return6m: 0.08, return12m: 0.10,
  fundamentals: { revenueGrowthYoY: 0.05, operatingMargin: 0.15, netDebtToEbitda: 1.0, freeCashFlow: 1e9, direction: "roughly_unchanged" },
  valuation: { forwardPe: 25, trailingPe: 28, historical5yPe: 26, pegRatio: 1.8, fcfYield: 0.03 },
  catalysts: { daysToEarnings: 40, revisionsUp: 1, revisionsDown: 1, oneYearTarget: 110 },
  options: null, ...overrides
});

const scoreTone = (score) => !Number.isFinite(score) ? "muted" : score >= 70 ? "pos" : score >= 45 ? "warn" : "neg";

/** One build's snapshot for a two-stock market. */
const snapshotOf = (overrides = {}) => {
  const records = [stock("AAA", overrides), stock("SPY", { etf: true, fundamentals: null })];
  const ctx = buildMarketContext(records, {});
  return snapshotFromEvaluations(records.map(r => evaluateAsset(r, ctx)), ctx);
};

test("a build's sample carries the scores, price and every bear/bull horizon", () => {
  const records = [stock("AAA"), stock("SPY", { etf: true, fundamentals: null })];
  const ctx = buildMarketContext(records, {});
  const sample = sampleFromEvaluation(evaluateAsset(records[0], ctx), ctx.spy);

  assert.equal(sample.n, 1);
  assert.equal(sample.price, 100);
  for (const key of ["overall", "quality", "trend", "entry", "trade"]) {
    assert.ok(Number.isFinite(sample[key]), `${key} is a number`);
  }
  assert.deepEqual(Object.keys(sample.bull), ["24h", "5d", "30d", "6m", "12m"]);
  assert.ok(sample.verdict && sample.bucket);
});

test("a sample keeps the raw inputs the engine read, not only the scores it produced", () => {
  const records = [stock("AAA", { rsi14: 61, hv30: 0.28 }), stock("SPY", { etf: true, fundamentals: null })];
  const ctx = buildMarketContext(records, {});
  const sample = sampleFromEvaluation(evaluateAsset(records[0], ctx), ctx.spy);

  // None of this can be backfilled, so the fields a later model would train on have to be written down today.
  assert.equal(sample.inputs.rsi14, 61);
  assert.equal(sample.inputs.hv30, 0.28);
  assert.equal(sample.inputs.revenueGrowthYoY, 0.05);
  assert.equal(sample.inputs.forwardPe, 25);
  assert.equal(sample.inputs.daysToEarnings, 40);
  assert.equal(sample.inputs.return12m, 0.10);
  assert.equal(sample.inputs.entrySupport, 96, "the levels the engine derived are kept too");
  assert.ok(Number.isFinite(sample.inputs.rewardRisk));
  // This fixture has no options chain, so that gap is recorded rather than silently scored as average.
  assert.ok(sample.gaps > 0);
  assert.equal(sample.inputs.impliedVolatility, undefined, "a missing input is absent, never zero");
});

test("the day's market backdrop is stored with it", () => {
  const snapshot = snapshotOf();
  assert.ok(["BULLISH", "NEUTRAL", "CAUTIOUS", "BEARISH"].includes(snapshot.regime));
  const day = foldDay(null, snapshot, "2026-09-15T15:00:00+00:00", "2026-09-15");
  assert.equal(day.breadth, snapshot.breadth);
});

test("raw inputs average across the day like the scores do", () => {
  const morning = { n: 1, price: 100, overall: 60, bull: {}, verdict: "Watch", bucket: "watch", inputs: { rsi14: 40, forwardPe: 20 } };
  const afternoon = { n: 1, price: 110, overall: 70, bull: {}, verdict: "Watch", bucket: "watch", inputs: { rsi14: 60, impliedVolatility: 0.3 } };

  const day = foldSample(morning, afternoon);
  assert.equal(day.inputs.rsi14, 50);
  assert.equal(day.inputs.forwardPe, 20, "an input only the first build had is kept");
  assert.equal(day.inputs.impliedVolatility, 0.3, "an input only the later build had is picked up");
});

test("repeated builds in one day average into a single entry", () => {
  const morning = { n: 1, price: 100, overall: 60, quality: 50, trend: 60, entry: 70, trade: 80, bull: { "30d": 40 }, verdict: "Watch", bucket: "watch" };
  const midday = { n: 1, price: 110, overall: 70, quality: 60, trend: 70, entry: 80, trade: 90, bull: { "30d": 60 }, verdict: "Buy zone", bucket: "buy" };
  const afternoon = { n: 1, price: 120, overall: 80, quality: 70, trend: 80, entry: 90, trade: 100, bull: { "30d": 80 }, verdict: "Watch", bucket: "watch" };

  const day = foldSample(foldSample(morning, midday), afternoon);
  assert.equal(day.n, 3);
  assert.equal(day.price, 110);
  assert.equal(day.overall, 70);
  assert.equal(day.bull["30d"], 60);
  // A verdict is a rule-based label, so the day keeps the last build's rather than inventing an average.
  assert.equal(day.verdict, "Watch");
  assert.equal(day.bucket, "watch");
});

test("a field missing from one build does not drag the day's average", () => {
  const withOptions = { n: 1, price: 100, overall: 60, trade: 80, bull: { "30d": 50 }, verdict: "Watch", bucket: "watch" };
  const feedFailed = { n: 1, price: 102, overall: 62, trade: null, bull: {}, verdict: "Watch", bucket: "watch" };

  const day = foldSample(withOptions, feedFailed);
  assert.equal(day.trade, 80, "keeps the reading it has instead of averaging against a gap");
  assert.equal(day.bull["30d"], 50);
  assert.equal(day.price, 101);

  // The reverse order behaves the same way: a first build without the field takes the second build's value.
  assert.equal(foldSample(feedFailed, withOptions).trade, 80);
});

test("folding a build into a day creates it once and then accumulates", () => {
  const snapshot = snapshotOf();
  const first = foldDay(null, snapshot, "2026-09-15T15:00:00+00:00", "2026-09-15");
  assert.equal(first.day, "2026-09-15");
  assert.equal(first.regime, snapshot.regime);
  assert.equal(first.tickers.AAA.n, 1);

  const second = foldDay(first, snapshot, "2026-09-15T19:00:00+00:00", "2026-09-15");
  assert.equal(second.tickers.AAA.n, 2);
  assert.equal(second.generatedAt, "2026-09-15T19:00:00+00:00");
  assert.equal(second.tickers.AAA.overall, first.tickers.AAA.overall, "the same build twice averages to itself");

  // A stock that only appears in a later build starts its own count rather than inheriting the day's.
  const withNew = foldDay(second, { regime: snapshot.regime, tickers: { BBB: { n: 1, price: 5, overall: 50, bull: {}, verdict: "Watch", bucket: "watch" } } }, "2026-09-15T23:00:00+00:00", "2026-09-15");
  assert.equal(withNew.tickers.BBB.n, 1);
  assert.equal(withNew.tickers.AAA.n, 2);
});

test("all three weekday builds land on the same market day", () => {
  // 15:00 / 19:00 / 23:00 UTC is 11am / 3pm / 7pm in New York, and 23:00 UTC is still the same day there.
  for (const hour of ["15", "19", "23"]) {
    assert.equal(marketDay(`2026-09-15T${hour}:00:00+00:00`), "2026-09-15");
  }
  // Past midnight UTC the New York date is still the previous session.
  assert.equal(marketDay("2026-09-16T02:00:00+00:00"), "2026-09-15");
});

const day = (date, tickers) => ({ day: date, tickers });
const entry = (price, overall, bull30) => ({ n: 3, price, overall, quality: overall, trend: overall, entry: overall, trade: overall, bull: { "30d": bull30 }, verdict: "Watch", bucket: "watch" });

test("stored days become one row per ticker, newest column first", () => {
  const { days, rows } = historyRows([
    day("2026-09-14", { AAA: entry(100, 60, 40), BBB: entry(50, 70, 80) }),
    day("2026-09-16", { AAA: entry(110, 65, 55) }),
    day("2026-09-15", { AAA: entry(105, 62, 50), BBB: entry(52, 72, 82) })
  ]);

  assert.deepEqual(days, ["2026-09-16", "2026-09-15", "2026-09-14"]);
  assert.deepEqual(rows.map(r => r.ticker), ["AAA", "BBB"]);

  const aaa = rows[0];
  assert.deepEqual(aaa.cells.map(c => c.price), [110, 105, 100]);
  assert.equal(aaa.firstSeen, "2026-09-14");
  assert.equal(aaa.sessions, 3);
  assert.equal(aaa.sinceFirst.toFixed(2), "0.10");

  // BBB was not recorded on the newest day, so that column is empty but the row keeps its own history.
  const bbb = rows[1];
  assert.equal(bbb.cells[0], null);
  assert.equal(bbb.sessions, 2);
  assert.equal(bbb.firstSeen, "2026-09-14");
});

test("a watchlist restricts the rows without changing the columns", () => {
  const { days, rows } = historyRows([
    day("2026-09-15", { AAA: entry(100, 60, 40), BBB: entry(50, 70, 80) }),
    day("2026-09-16", { AAA: entry(110, 65, 55), BBB: entry(55, 72, 82) })
  ], { tickers: ["BBB"] });

  assert.deepEqual(rows.map(r => r.ticker), ["BBB"]);
  assert.equal(days.length, 2);
});

test("forward return measures each day against the sessions that followed", () => {
  const days = Array.from({ length: 7 }, (_, i) => day(`2026-09-${String(10 + i).padStart(2, "0")}`, { AAA: entry(100 + i * 10, 60, 50) }));
  const { rows } = historyRows(days, {});
  const row = rows[0];

  // Columns are newest first, so the oldest day is last: 100 then 150 five sessions later.
  const oldest = row.cells[row.cells.length - 1];
  assert.equal(oldest.forward[5].toFixed(4), (150 / 100 - 1).toFixed(4));
  // The two newest days have no session five ahead yet.
  assert.equal(row.cells[0].forward[5], null);
  assert.equal(row.cells[1].forward[5], null);
  // The row summary averages only the days that have an outcome (100→150 and 110→160).
  assert.equal(row.forward[5].toFixed(4), ((0.5 + 160 / 110 - 1) / 2).toFixed(4));
  assert.equal(row.forward[30], null, "no day has thirty sessions after it yet");
});

test("a day cell shows what the selected metric says", () => {
  const stored = entry(123.456, 74, 80);

  const bull = metricCell(stored, "bull", "30d", scoreTone);
  assert.equal(bull.text, bullWord(80));
  assert.equal(bull.text, "Bullish");
  assert.equal(bull.sub, "74", "the word carries the Overall score beside it");
  assert.equal(bull.tone, "pos");

  assert.equal(metricCell(stored, "bull", "12m", scoreTone).text, "—", "a horizon with no stored reading is blank");
  assert.equal(metricCell(stored, "verdict", "30d", scoreTone).text, "Watch", "the day cell shows the bucket; the full verdict is in the tooltip");
  assert.equal(metricCell(stored, "quality", "30d", scoreTone).text, "74");
  assert.equal(metricCell(stored, "price", "30d", scoreTone).text, "$123.46");
  assert.equal(metricCell(null, "bull", "30d", scoreTone).text, "—");
});

test("an averaged bear/bull position and its word never disagree", () => {
  // 58 is the Firm boundary: two builds either side of it must read as the word for their average, not for either one.
  const day = foldSample(
    { n: 1, price: 100, overall: 60, bull: { "30d": 40 }, verdict: "Watch", bucket: "watch" },
    { n: 1, price: 100, overall: 60, bull: { "30d": 80 }, verdict: "Watch", bucket: "watch" }
  );
  assert.equal(day.bull["30d"], 60);
  assert.equal(metricCell(day, "bull", "30d", scoreTone).text, bullWord(60));
  assert.equal(metricCell(day, "bull", "30d", scoreTone).text, "Firm");
});
