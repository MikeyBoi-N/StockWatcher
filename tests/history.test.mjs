import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketContext, evaluateAsset } from "../js/engine.js";
import { bullWord } from "../js/grades.js";
import {
  dailyAverages, foldSample, historyRecords, historyRows, marketDay, metricCell, sampleFromEvaluation, snapshotDocuments,
  snapshotFromEvaluations, snapshotId
} from "../js/history.js";

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

/** A stored snapshot document as the page reads it back (readings only, with its id). */
const stored = (generatedAt, tickers, extra = {}) => {
  const { id, snapshot } = snapshotDocuments({ regime: "BULLISH", breadth: 0.5, tickers, ...extra }, generatedAt);
  return { ...snapshot, id };
};
const reading = (price, overall, bull30 = 50, verdict = "Watch", bucket = "watch") =>
  ({ n: 1, price, overall, quality: overall, trend: overall, entry: overall, trade: overall, bull: { "30d": bull30 }, verdict, bucket });

/* ------------------------------------------------------------------ recording */

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

  // None of this can be backfilled, so the fields a later model would train on have to be written down now.
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

test("a build is keyed by its own timestamp, so recording it twice cannot count it twice", () => {
  assert.equal(snapshotId("2026-09-18T00:54:47+00:00"), "20260918T005447Z");
  assert.equal(snapshotId("2026-09-18T00:54:47.812Z"), "20260918T005447Z", "sub-second noise does not make a second id");
  assert.equal(snapshotId("2026-09-17T20:54:47-04:00"), "20260918T005447Z", "the same instant in another offset is the same build");
  // Ids sort in time order and carry nothing that needs escaping in a Firestore path.
  assert.ok(snapshotId("2026-09-18T15:00:00Z") > snapshotId("2026-09-18T00:54:47Z"));
  assert.match(snapshotId("2026-09-18T15:00:00Z"), /^[0-9TZ]+$/);
});

test("a build is stored as two documents: the readings the table shows and the inputs only the export needs", () => {
  const snapshot = snapshotOf({ rsi14: 61 });
  const { id, snapshot: readings, inputs } = snapshotDocuments(snapshot, "2026-09-18T19:02:11+00:00");

  assert.equal(id, "20260918T190211Z");
  assert.equal(readings.at, Date.parse("2026-09-18T19:02:11+00:00"), "`at` is what every query filters and sorts on");
  assert.equal(readings.day, "2026-09-18");
  assert.equal(readings.regime, snapshot.regime);
  assert.equal(readings.breadth, snapshot.breadth);
  assert.equal(readings.tickers.AAA.inputs, undefined, "the readings document carries no inputs");
  assert.equal(readings.tickers.AAA.overall, snapshot.tickers.AAA.overall);
  assert.equal(inputs.tickers.AAA.rsi14, 61);
  assert.equal(inputs.at, readings.at);
});

test("a day stored before snapshots were per build carries over honestly", () => {
  // The old per-day document: a running mean of two builds, stamped with the later one.
  const legacyDay = {
    day: "2026-09-17", regime: "BULLISH", breadth: 0.5625, generatedAt: "2026-09-18T00:54:47+00:00",
    tickers: { AAPL: { ...reading(250, 74), n: 2, inputs: { rsi14: 55 } } }
  };
  const { id, snapshot, inputs } = snapshotDocuments(legacyDay, legacyDay.generatedAt);

  assert.equal(id, "20260918T005447Z");
  assert.equal(snapshot.day, "2026-09-17", "8:54pm in New York is still the 17th");
  assert.equal(snapshot.tickers.AAPL.n, 2, "it still says it averages two builds");
  assert.equal(inputs.tickers.AAPL.rsi14, 55);
});

test("all three weekday builds land on the same market day, even when GitHub runs them late", () => {
  // Scheduled for 15:00 / 19:00 / 23:00 UTC; observed running as late as 18:39 / 21:49 / 00:52.
  for (const at of ["2026-09-17T15:00:00Z", "2026-09-17T18:39:17Z", "2026-09-17T21:49:25Z", "2026-09-18T00:52:15Z"]) {
    assert.equal(marketDay(at), "2026-09-17");
  }
});

/* ------------------------------------------------------------------ averaging */

test("repeated builds in one day average into a single reading", () => {
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

test("a reading that already averages several builds carries their weight", () => {
  const twoBuilds = { ...reading(100, 60), n: 2 };
  const oneBuild = reading(130, 90);
  const folded = foldSample(twoBuilds, oneBuild);
  assert.equal(folded.n, 3);
  assert.equal(folded.overall, 70, "(60 x 2 + 90) / 3, not a plain midpoint");
  assert.equal(folded.price, 110);
});

test("a field missing from one build does not drag the average", () => {
  const withOptions = { n: 1, price: 100, overall: 60, trade: 80, bull: { "30d": 50 }, verdict: "Watch", bucket: "watch" };
  const feedFailed = { n: 1, price: 102, overall: 62, trade: null, bull: {}, verdict: "Watch", bucket: "watch" };

  const day = foldSample(withOptions, feedFailed);
  assert.equal(day.trade, 80, "keeps the reading it has instead of averaging against a gap");
  assert.equal(day.bull["30d"], 50);
  assert.equal(day.price, 101);
  assert.equal(foldSample(feedFailed, withOptions).trade, 80, "and the same the other way round");
});

test("raw inputs average like the scores do", () => {
  const morning = { ...reading(100, 60), inputs: { rsi14: 40, forwardPe: 20 } };
  const afternoon = { ...reading(110, 70), inputs: { rsi14: 60, impliedVolatility: 0.3 } };

  const day = foldSample(morning, afternoon);
  assert.equal(day.inputs.rsi14, 50);
  assert.equal(day.inputs.forwardPe, 20, "an input only the first build had is kept");
  assert.equal(day.inputs.impliedVolatility, 0.3, "an input only the later build had is picked up");
});

test("daily averages fold each market day's builds and keep the day's last regime", () => {
  const snapshots = [
    stored("2026-09-17T15:00:00Z", { AAA: reading(100, 60) }, { regime: "NEUTRAL" }),
    stored("2026-09-17T19:00:00Z", { AAA: reading(110, 70) }, { regime: "BULLISH" }),
    stored("2026-09-18T15:00:00Z", { AAA: reading(120, 80) })
  ];
  const days = dailyAverages(snapshots);

  assert.deepEqual(days.map(d => d.day), ["2026-09-17", "2026-09-18"]);
  assert.equal(days[0].tickers.AAA.n, 2);
  assert.equal(days[0].tickers.AAA.overall, 65);
  assert.equal(days[0].regime, "BULLISH");
  assert.equal(days[0].at, Date.parse("2026-09-17T19:00:00Z"));
});

/* ------------------------------------------------------------------ the table */

// Two weekdays and a weekend push, then a Monday: 17th Thu, 18th Fri, 19th Sat, 21st Mon.
const week = () => [
  stored("2026-09-17T15:00:00Z", { AAA: reading(100, 60, 40) }),
  stored("2026-09-17T23:00:00Z", { AAA: reading(102, 62, 45), BBB: reading(50, 70, 80) }),
  stored("2026-09-18T15:00:00Z", { AAA: reading(104, 64, 50), BBB: reading(52, 72, 82) }),
  stored("2026-09-18T23:00:00Z", { AAA: reading(106, 66, 55), BBB: reading(54, 74, 84) }),
  stored("2026-09-19T16:00:00Z", { AAA: reading(106, 66, 55), BBB: reading(54, 74, 84) }),
  stored("2026-09-21T23:00:00Z", { AAA: reading(110, 70, 60), BBB: reading(55, 75, 85) })
];

test("every build is its own column, newest first", () => {
  const { columns, rows } = historyRows(week());

  assert.equal(columns.length, 6);
  assert.deepEqual(columns.map(c => c.id), ["20260921T230000Z", "20260919T160000Z", "20260918T230000Z", "20260918T150000Z", "20260917T230000Z", "20260917T150000Z"]);
  assert.equal(columns[0].tickers, undefined, "columns describe the snapshot; the readings live in the rows");
  assert.deepEqual(rows.map(r => r.ticker), ["AAA", "BBB"]);

  const aaa = rows[0];
  assert.deepEqual(aaa.cells.map(c => c.price), [110, 106, 106, 104, 102, 100]);
  assert.equal(aaa.firstSeen, "2026-09-17");
  assert.equal(aaa.sinceFirst.toFixed(2), "0.10");

  // BBB first appeared in the evening build, so the morning column is empty for it.
  assert.equal(rows[1].cells[5], null);
  assert.equal(rows[1].firstSeen, "2026-09-17");
});

test("the daily resolution folds each day's builds into one column", () => {
  const { columns, rows } = historyRows(week(), { resolution: "daily" });

  assert.deepEqual(columns.map(c => c.day), ["2026-09-21", "2026-09-19", "2026-09-18", "2026-09-17"]);
  const aaa = rows[0];
  assert.equal(aaa.cells[3].price, 101, "the 17th averages its 100 and 102 builds");
  assert.equal(aaa.cells[3].n, 2);
});

test("forward returns count sessions from each day's last snapshot and skip weekend builds", () => {
  const snapshots = [
    ...week(),
    stored("2026-09-22T23:00:00Z", { AAA: reading(112, 70) }),
    stored("2026-09-23T23:00:00Z", { AAA: reading(114, 70) }),
    stored("2026-09-24T23:00:00Z", { AAA: reading(116, 70) })
  ];
  const { columns, rows } = historyRows(snapshots);
  const aaa = rows[0];
  const cellAt = (id) => aaa.cells[columns.findIndex(c => c.id === id)];

  // Sessions: 17 (close 102), 18 (106), 21 (110), 22 (112), 23 (114), 24 (116). Saturday the 19th is not one.
  assert.equal(aaa.sessions, 6);
  assert.equal(cellAt("20260917T230000Z").forward[5].toFixed(4), (116 / 102 - 1).toFixed(4));
  assert.equal(cellAt("20260917T150000Z").forward[5], cellAt("20260917T230000Z").forward[5], "both builds of a day share the day's outcome");
  assert.equal(cellAt("20260918T150000Z").forward[5], null, "the 18th has only four sessions after it so far");
  assert.equal(aaa.forward[5].toFixed(4), (116 / 102 - 1).toFixed(4), "the row averages only the days that have an outcome");
  assert.equal(aaa.forward[30], null);
});

test("a single snapshot has no change to report yet", () => {
  const { rows } = historyRows([stored("2026-09-17T23:00:00Z", { AAA: reading(100, 60) })]);
  assert.equal(rows[0].sinceFirst, null, "blank rather than a made-up 0%");
  assert.equal(rows[0].forward[5], null);
});

test("the export has one record per stock per build, oldest first, with its inputs joined", () => {
  const snapshots = week().slice(0, 3);
  const inputsById = new Map([[snapshots[1].id, { tickers: { AAA: { rsi14: 55 }, BBB: { rsi14: 70 } } }]]);
  const records = historyRecords(snapshots, inputsById);

  assert.deepEqual(records.map(r => `${r.id} ${r.ticker}`), [
    "20260917T150000Z AAA", "20260917T230000Z AAA", "20260917T230000Z BBB", "20260918T150000Z AAA", "20260918T150000Z BBB"
  ]);
  assert.equal(records[1].inputs.rsi14, 55);
  assert.deepEqual(records[0].inputs, {}, "a snapshot without an inputs document exports blank inputs, not zeros");
  assert.equal(records[1].regime, "BULLISH");
  assert.equal(records[1].reading.price, 102);
});

/* ------------------------------------------------------------------ cells */

test("a cell shows what the selected metric says", () => {
  const entry = reading(123.456, 74, 80);

  const bull = metricCell(entry, "bull", "30d", scoreTone);
  assert.equal(bull.text, bullWord(80));
  assert.equal(bull.text, "Bullish");
  assert.equal(bull.sub, "74", "the word carries the Overall score beside it");
  assert.equal(bull.tone, "pos");

  assert.equal(metricCell(entry, "bull", "12m", scoreTone).text, "—", "a horizon with no stored reading is blank");
  assert.equal(metricCell(entry, "verdict", "30d", scoreTone).text, "Watch", "the cell shows the bucket; the full verdict is in the tooltip");
  assert.equal(metricCell(entry, "quality", "30d", scoreTone).text, "74");
  assert.equal(metricCell(entry, "price", "30d", scoreTone).text, "$123.46");
  assert.equal(metricCell(null, "bull", "30d", scoreTone).text, "—");
});

test("an averaged bear/bull position and its word never disagree", () => {
  // 58 is the Firm boundary: two builds either side of it must read as the word for their average, not for either one.
  const day = foldSample(
    { n: 1, price: 100, overall: 60, bull: { "30d": 40 }, verdict: "Watch", bucket: "watch" },
    { n: 1, price: 100, overall: 60, bull: { "30d": 80 }, verdict: "Watch", bucket: "watch" }
  );
  assert.equal(day.bull["30d"], 60);
  assert.equal(metricCell(day, "bull", "30d", scoreTone).text, "Firm");
});
