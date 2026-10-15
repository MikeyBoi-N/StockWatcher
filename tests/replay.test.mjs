import { test } from "node:test";
import assert from "node:assert/strict";
import { compareWithSector, decodeReplay, engineMatches, forwardReturn, liveRecord, replayStates, scorecard, spearman, trailingBeta } from "../js/replay.js";
import { prepare, rng } from "../js/simulator.js";

const FIELDS = ["price", "prevClose", "high52", "low52", "sma20", "sma50", "sma200", "rsi14", "hv30", "majorSupport", "entrySupport",
  "majorResistance", "return3m", "return12m"];

/** Weekday dates as YYYYMMDD from Mon 2 Jan 2023. */
function weekdays(n) {
  const out = [];
  const d = new Date(Date.UTC(2023, 0, 2));
  while (out.length < n) {
    if (d.getUTCDay() % 6) out.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate());
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** A replay.json-shaped payload: random-walk bars and a row every 5 bars with simple engine inputs. */
function fakeReplay(tickers, n = 420, seed = 1) {
  const d = weekdays(n);
  const out = { generatedAt: "2026-10-15T00:00:00Z", fields: FIELDS, tickers: {} };
  tickers.forEach((ticker, k) => {
    const rand = rng(seed + k);
    const c = [100];
    for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(0.015 * (rand() - 0.5) * 3.4));
    const mean = (i, p) => c.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p;
    const rows = [];
    for (let i = 260; i < n; i += 5) {
      const p = c[i];
      rows.push([i, p, c[i - 1], Math.max(...c.slice(i - 251, i + 1)), Math.min(...c.slice(i - 251, i + 1)), mean(i, 20), mean(i, 50), mean(i, 200),
        40 + 30 * rand(), 0.3, p * 0.9, p * 0.96, p * 1.08, p / c[i - 63] - 1, p / c[i - 252] - 1]);
    }
    out.tickers[ticker] = {
      etf: ["SPY", "QQQ"].includes(ticker), sector: "Technology",
      bars: { d, o: c.map((v, i) => i ? c[i - 1] : v), h: c.map(v => v * 1.01), l: c.map(v => v * 0.99), c, v: c.map(() => 1000) },
      rows
    };
  });
  return out;
}

const TICKERS = ["SPY", "QQQ", ...Array.from({ length: 12 }, (_, i) => `S${i}`)];

test("decodeReplay turns compact rows into engine records on the right candles", () => {
  const replay = decodeReplay(fakeReplay(["SPY", "QQQ", "AAA"]));
  const aaa = replay.tickers.AAA;
  assert.equal(aaa.candles[0].t, Date.UTC(2023, 0, 2));
  assert.equal(aaa.rows[0].i, 260);
  assert.equal(aaa.rows[0].record.price, aaa.candles[260].c);
  assert.equal(aaa.rows[0].record.fundamentals, null, "only price data is replayed");
});

test("replayStates runs the engine for every replayed week with SPY present", () => {
  const replay = decodeReplay(fakeReplay(TICKERS));
  const states = replayStates(replay);
  assert.equal(states.length, TICKERS.length * replay.tickers.SPY.rows.length);
  assert.ok(states.every(s => ["buy", "strong", "watch", "avoid"].includes(s.bucket)));
  assert.ok(states.every(s => s.features.length === 8 && s.features.every(Number.isFinite)));
  assert.ok(states.every((s, i) => i === 0 || s.t >= states[i - 1].t), "oldest first");
});

test("spearman ranks with ties", () => {
  assert.equal(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
  assert.equal(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  assert.ok(Math.abs(spearman([1, 1, 2, 2, 3], [1, 1, 2, 2, 3]) - 1) < 1e-12);
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), null);
});

test("the scorecard tests stocks only, on dates a full window apart", () => {
  const replay = decodeReplay(fakeReplay(TICKERS));
  const states = replayStates(replay);
  for (const sessions of [5, 21]) {
    const card = scorecard(replay, states, { sessions, costBps: 10 });
    const stride = Math.ceil(sessions / 5);
    const eligible = [...new Set(states.map(s => s.t))].filter(t => {
      const i = replay.tickers.SPY.candles.findIndex(k => k.t === t);
      return i + sessions < replay.tickers.SPY.candles.length;
    });
    assert.equal(card.dates, Math.ceil(eligible.length / stride));
    const total = Object.values(card.buckets).reduce((s, b) => s + b.n, 0);
    assert.equal(total, card.dates * 12, "12 stocks per date, ETFs excluded");
    for (const b of Object.values(card.buckets)) if (b.n) assert.ok(Math.abs(b.net - (b.raw.mean - 0.001)) < 1e-12);
  }
});

test("engine matches only use readings whose whole window had happened by the origin", () => {
  const replay = decodeReplay(fakeReplay(TICKERS));
  const states = replayStates(replay);
  const preps = new Map(Object.entries(replay.tickers).map(([t, s]) => [t, prepare(s.candles)]));
  const origin = 360, horizon = 21;
  const originT = replay.tickers.S3.candles[origin].t;
  const matches = engineMatches(replay, states, preps, "S3", origin, { horizon, count: 30 });
  assert.ok(matches.length > 0);
  for (const m of matches) {
    assert.ok(replay.tickers[m.ticker].candles[m.end + horizon].t <= originT);
    assert.equal(m.prep, preps.get(m.ticker));
  }
  assert.ok(Math.abs(matches.reduce((s, m) => s + m.weight, 0) - 1) < 1e-9);
  assert.deepEqual(engineMatches(replay, states, preps, "S3", 100, { horizon }), [], "no reading before the first replayed week");
});

test("the live record keeps one build per day and only days a full window apart", () => {
  const replay = decodeReplay(fakeReplay(TICKERS));
  const day = (i) => new Date(replay.tickers.SPY.candles[i].t).toISOString().slice(0, 10);
  const reading = { bucket: "buy" };
  const snapshots = [];
  for (let i = 380; i < 400; i++) {
    snapshots.push({ day: day(i), at: i * 10, tickers: { S1: { bucket: "watch" }, SPY: reading } });
    snapshots.push({ day: day(i), at: i * 10 + 1, tickers: { S1: reading, S2: reading, SPY: reading } });
  }
  const live = liveRecord(replay, snapshots, { sessions: 5 });
  assert.equal(live.eligibleDays, 20);
  assert.equal(live.days, 4);
  assert.equal(live.buckets.buy.n, 8, "the later build of each day wins and ETFs are left out");
  assert.equal(live.buckets.watch.n, 0);
});

test("outcomes are total returns bought at the next close", () => {
  const candles = [100, 101, 102, 103, 104].map((c, i) => ({ t: i, c, a: c * (1 + 0.01 * i) }));
  // Reading at bar 0, bought at bar 1's adjusted close, held 2 sessions to bar 3.
  assert.ok(Math.abs(forwardReturn(candles, 0, 2) - (103 * 1.03) / (101 * 1.01) + 1) < 1e-12);
  assert.equal(forwardReturn(candles, 2, 2), null, "the window runs past the data");
  const raw = candles.map(({ t, c }) => ({ t, c, a: null }));
  assert.ok(Math.abs(forwardReturn(raw, 0, 2) - (103 / 101 - 1)) < 1e-12, "raw closes when no adjusted ones exist");
});

test("sector peers: each stock is compared with its sector that week, small sectors with the leftovers", () => {
  const rows = [
    { s: "Tech", excess: 0.05 }, { s: "Tech", excess: 0.03 }, { s: "Tech", excess: 0.01 },
    { s: "Energy", excess: -0.02 }, { s: null, excess: 0.04 }
  ];
  compareWithSector(rows, "sector", r => r.s);
  assert.deepEqual(rows.slice(0, 3).map(r => +r.excess.toFixed(6)), [0.02, 0, -0.02]);
  assert.deepEqual(rows.slice(3).map(r => +r.excess.toFixed(6)), [-0.03, 0.03]);
  const untouched = [{ s: "Tech", excess: 0.05 }];
  compareWithSector(untouched, "beta", r => r.s);
  assert.equal(untouched[0].excess, 0.05);
});

test("beta is shrunk a third of the way to 1", () => {
  const rand = rng(5);
  const spy = [], stock = [];
  let a = 100, b = 100;
  for (let i = 0; i < 300; i++) {
    const m = 0.01 * (rand() - 0.5);
    a *= Math.exp(m); b *= Math.exp(2 * m);
    spy.push({ t: i, c: a, a: null }); stock.push({ t: i, c: b, a: null });
  }
  const spyIndex = new Map(spy.map((k, i) => [k.t, i]));
  assert.ok(Math.abs(trailingBeta(stock, 299, spy, spyIndex) - (0.67 * 2 + 0.33)) < 1e-9);
  assert.equal(trailingBeta(stock, 50, spy, spyIndex), null, "needs 120 shared days");
});
