import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNALS, buildPanel, fitRidge, makePredictor, signalStats, walkForward } from "../js/signals.js";
import { decodeReplay, replayStates, excessReturn } from "../js/replay.js";
import { rng } from "../js/simulator.js";

const FIT = SIGNALS.filter(s => s.fit !== false).map(s => s.key);

/**
 * A synthetic panel: `dates` weekly cross-sections of `stocks` rows, each with random rank-like signals, where the
 * outcome is `edge` times the momentum signal plus noise. Outcome windows are 4 weeks (si steps of 5, sessions 20).
 */
function syntheticPanel({ dates = 160, stocks = 40, edge = 0.01, seed = 3 } = {}) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const m = FIT.indexOf("momentum");
  const out = { sessions: 20, dates: [] };
  for (let d = 0; d < dates; d++) {
    const rows = [];
    for (let k = 0; k < stocks; k++) {
      const x = Float64Array.from(FIT, () => Math.sqrt(3) * (2 * rand() - 1));
      const excess = edge * x[m] + 0.03 * gauss();
      rows.push({ ticker: `S${k}`, x, ranks: Object.fromEntries(FIT.map((key, i) => [key, x[i]])), excess, y: excess });
    }
    const mean = rows.reduce((s, r) => s + r.y, 0) / rows.length;
    for (const r of rows) r.y -= mean;
    out.dates.push({ t: d * 7 * 86400000, si: d * 5, rows });
  }
  return out;
}

test("ridge recovers the one signal that matters", () => {
  const fit = fitRidge(syntheticPanel().dates);
  const m = FIT.indexOf("momentum");
  assert.ok(fit.beta[m] > 0.006, `momentum weight ${fit.beta[m]}`);
  for (let i = 0; i < FIT.length; i++) if (i !== m) assert.ok(Math.abs(fit.beta[i]) < 0.003, `${FIT[i]} weight ${fit.beta[i]}`);
  assert.equal(fitRidge(syntheticPanel({ dates: 30 }).dates), null, "a year of weeks is required");
});

test("walk-forward finds a real edge and none in pure noise", () => {
  const real = walkForward(syntheticPanel());
  assert.ok(real.tested > 20);
  assert.ok(real.ic.mean - 2 * real.ic.se > 0, `IC ${real.ic.mean} ± ${real.ic.se}`);
  assert.equal(real.final.weights[0].key, "momentum");
  const noise = walkForward(syntheticPanel({ edge: 0, seed: 9 }));
  assert.ok(Math.abs(noise.ic.mean) < 3 * noise.ic.se, `noise IC ${noise.ic.mean} ± ${noise.ic.se}`);
});

test("the predictor never trains on outcomes that hadn't finished by the origin", () => {
  const panel = syntheticPanel();
  const origin = panel.dates[100].t;
  const before = makePredictor(panel)("S3", origin);
  // Poison every outcome whose window ends after the origin's week: the prediction must not move.
  const poisoned = syntheticPanel();
  for (const d of poisoned.dates) if (d.si + poisoned.sessions > poisoned.dates[100].si) for (const r of d.rows) r.y = 1e3 * (r.x[0] + 1);
  assert.equal(makePredictor(poisoned)("S3", origin), before);
  assert.equal(makePredictor(panel)("S3", panel.dates[10].t), null, "too little history yet");
});

test("panels rank signals within each week, leave out ETFs and demean the target", () => {
  const n = 420, d = [];
  for (let day = new Date(Date.UTC(2023, 0, 2)); d.length < n; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() % 6) d.push(day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate());
  }
  const fields = ["price", "high52", "low52", "sma50", "sma200", "rsi14", "hv30", "return1m", "return5d", "return3m", "return12m", "volume", "avgVolume20"];
  const json = { fields, tickers: {} };
  ["SPY", "QQQ", "AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].forEach((ticker, k) => {
    const rand = rng(k + 1);
    const c = [100];
    for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + 0.02 * (rand() - 0.5)));
    const rows = [];
    for (let i = 260; i < n; i += 5) rows.push([i, c[i], c[i] * 1.2, c[i] * 0.8, c[i], c[i] * 0.95, 50, 0.1 + 0.05 * k, c[i] / c[i - 21] - 1, c[i] / c[i - 5] - 1, 0.01, 0.1 * k, 1000, 900]);
    json.tickers[ticker] = { etf: ticker === "SPY" || ticker === "QQQ", sector: null, bars: { d, o: null, h: c, l: c, c, v: c.map(() => 1000) }, rows };
  });
  const replay = decodeReplay(json);
  const states = replayStates(replay);
  const panel = buildPanel(replay, states, { sessions: 21 });
  const first = panel.dates[0];
  assert.equal(first.rows.length, 6, "SPY and QQQ are benchmarks, not candidates");
  assert.deepEqual(first.rows.map(r => r.ranks.volatility).sort((a, b) => a - b).map(v => +v.toFixed(6)),
    [-1, -0.6, -0.2, 0.2, 0.6, 1].map(v => +(v * Math.sqrt(3)).toFixed(6)));
  assert.ok(Math.abs(first.rows.reduce((s, r) => s + r.y, 0)) < 1e-12);
  const row = first.rows[0], st = row.state;
  const r = replay.tickers[row.ticker].candles[st.i + 21].c / replay.tickers[row.ticker].candles[st.i].c - 1;
  const m = replay.tickers.SPY.candles[first.si + 21].c / replay.tickers.SPY.candles[first.si].c - 1;
  assert.ok(Math.abs(row.excess - excessReturn(r, m, st.beta, "beta")) < 1e-12);
  const plain = buildPanel(replay, states, { sessions: 21, benchmark: "spy" }).dates[0].rows[0];
  assert.ok(Math.abs(plain.excess - ((1 + r) / (1 + m) - 1)) < 1e-12);
  assert.ok(Object.keys(signalStats(panel)).length === SIGNALS.length);
});
