import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprints, newRegistration, scorePaper } from "../js/paper.js";
import { decodeReplay, replayStates, testDates } from "../js/replay.js";
import { FIT_KEYS } from "../js/signals.js";
import { rng } from "../js/simulator.js";

const FIELDS = ["price", "prevClose", "high52", "low52", "sma20", "sma50", "sma200", "rsi14", "hv30", "majorSupport", "entrySupport",
  "majorResistance", "return5d", "return1m", "return3m", "return12m", "volume", "avgVolume20"];

/** A replay.json-shaped payload of random walks with a row every 5 bars from bar 260. */
function fakeReplay(n = 520) {
  const d = [];
  for (const day = new Date(Date.UTC(2023, 0, 2)); d.length < n; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() % 6) d.push(day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate());
  }
  const json = { fields: FIELDS, tickers: {} };
  ["SPY", "QQQ", ...Array.from({ length: 14 }, (_, i) => `S${i}`)].forEach((ticker, k) => {
    const rand = rng(k + 11);
    const c = [100];
    for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(0.02 * (rand() - 0.5)));
    const mean = (i, p) => c.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p;
    const rows = [];
    for (let i = 260; i < n; i += 5) {
      rows.push([i, c[i], c[i - 1], Math.max(...c.slice(i - 251, i + 1)), Math.min(...c.slice(i - 251, i + 1)), mean(i, 20), mean(i, 50), mean(i, 200),
        30 + 40 * rand(), 0.2 + 0.2 * rand(), c[i] * 0.9, c[i] * 0.95, c[i] * 1.08, c[i] / c[i - 5] - 1, c[i] / c[i - 21] - 1, c[i] / c[i - 63] - 1, c[i] / c[i - 252] - 1, 1000, 900]);
    }
    json.tickers[ticker] = { etf: k < 2, sector: k % 2 ? "Tech" : "Energy", bars: { d, o: null, h: c, l: c, c, a: null, v: c.map(() => 1000) }, rows };
  });
  return decodeReplay(json);
}

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const weights = Object.fromEntries(FIT_KEYS.map((k, i) => [k, i === 0 ? 0.01 : 0]));
const registration = (replay, registeredOn) => newRegistration({
  registeredOn, dataThrough: registeredOn, fit: { weights, rows: 1, dates: 1 },
  universe: Object.entries(replay.tickers).filter(([, s]) => !s.etf).map(([t]) => t)
});

test("fingerprints are stable and every hypothesis is fixed at registration", () => {
  assert.deepEqual(fingerprints(), fingerprints());
  const replay = fakeReplay();
  const spec = registration(replay, "2023-11-01");
  assert.deepEqual(spec.hypotheses.map(h => h.id), ["H1", "H2", "H3", "H4"]);
  assert.ok(spec.hypotheses.every(h => h.minDates > 0 && h.sessions > 0 && h.statement && h.measures));
  assert.deepEqual(spec.hypotheses.find(h => h.id === "H2").weights, weights);
  assert.equal(spec.passRule.z, 2.25);
});

test("only weeks after registration count, one per outcome window", () => {
  const replay = fakeReplay();
  const states = replayStates(replay);
  const spec = registration(replay, "2023-11-01");
  const scored = scorePaper(spec, replay, states, []);
  const h3 = scored.find(h => h.id === "H3");
  // Weekly rows after the registration date whose 21-session window (after the entry day) has finished.
  const spy = replay.tickers.SPY.candles;
  const after = replay.tickers.SPY.rows.map(r => r.i).filter(i => spy[i].t > Date.parse("2023-11-01T23:59:59Z") && i + 1 + 21 < spy.length);
  assert.equal(h3.estimate.n, testDates(after.map(i => spy[i].t), 21).length);
  assert.equal(h3.status, h3.estimate.n >= h3.minDates ? (h3.z >= 2.25 ? "passed" : "failed") : "collecting");
  const later = scorePaper(registration(replay, isoDay(spy.at(-1).t)), replay, states, []);
  assert.ok(later.every(h => h.estimate.n === 0 && h.status === "collecting"), "nothing to score yet on registration day");
});

test("a hypothesis is only judged once it has its minimum number of tests", () => {
  const replay = fakeReplay(620);
  const states = replayStates(replay);
  const spec = registration(replay, "2023-11-01");
  for (const h of spec.hypotheses) h.minDates = 3;
  const scored = scorePaper(spec, replay, states, []);
  for (const h of scored.filter(h => h.source !== "published")) {
    assert.ok(h.estimate.n >= 3, `${h.id} has ${h.estimate.n} tests`);
    assert.equal(h.status, h.z >= 2.25 ? "passed" : "failed", h.id);
  }
});

test("a changed definition flags exactly the hypotheses that depend on it", () => {
  const replay = fakeReplay();
  const states = replayStates(replay);
  const spec = registration(replay, "2023-11-01");
  spec.fingerprints.signals.volume = "00000000";
  const byId = Object.fromEntries(scorePaper(spec, replay, states, []).map(h => [h.id, h]));
  assert.equal(byId.H2.status, "invalid", "the model uses volume");
  assert.deepEqual(byId.H2.changed, ["signals.volume"]);
  assert.notEqual(byId.H3.status, "invalid");
  assert.notEqual(byId.H4.status, "invalid");
  spec.fingerprints.engine = "00000000";
  const again = Object.fromEntries(scorePaper(spec, replay, states, []).map(h => [h.id, h]));
  assert.equal(again.H1.status, "invalid");
  assert.equal(again.H4.status, "invalid", "Overall is an engine score");
  assert.notEqual(again.H3.status, "invalid", "last week's return doesn't touch the engine");
});
