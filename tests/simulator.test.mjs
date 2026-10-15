import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, simulate, fan, crps, quantile, backtest, earningsEvents, findAnalogs, fitGjr, likelyPath, rng, MODELS } from "../js/simulator.js";
import { marketJsonCandles } from "../js/sim-sources.js";

/** A random walk with wicks and volume, from a fixed seed. */
function walk(n, seed = 3, sigma = 0.01) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const candles = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = o * Math.exp(sigma * gauss());
    candles.push({ t: i * 60000, o, h: Math.max(o, c) * (1 + 0.003 * rand()), l: Math.min(o, c) * (1 - 0.003 * rand()), c, v: 10 + 5 * rand() });
  }
  return candles;
}

test("prepare drops bad candles and repairs highs and lows", () => {
  const prep = prepare([
    { t: 1, o: 10, h: 11, l: 9, c: 10 },
    { t: 2, o: 10, h: null, l: null, c: NaN },
    { t: 3, o: 10, h: 9, l: 12, c: 11 },
    { t: 4, c: 12 }
  ]);
  assert.equal(prep.n, 3);
  assert.deepEqual(prep.candles[1], { t: 3, o: 10, h: 11, l: 10, c: 11, v: null });
  assert.equal(prep.candles[2].o, 11, "a closes-only candle opens at the previous close");
  assert.ok(prep.sigma.every(s => s > 0));
  assert.throws(() => prepare([{ c: 1 }, { c: 2 }]), /at least 3/);
});

test("every model draws the same futures from the same seed, with valid candles", () => {
  const prep = prepare(walk(600));
  for (const { key } of MODELS) {
    const a = simulate(prep, { model: key, horizon: 20, paths: 50, seed: 9 });
    const b = simulate(prep, { model: key, horizon: 20, paths: 50, seed: 9 });
    assert.deepEqual(a.candles, b.candles, key);
    for (let i = 0; i < a.candles.length; i += 4) {
      const [o, h, l, c] = a.candles.subarray(i, i + 4);
      assert.ok(l > 0 && l <= Math.min(o, c) && h >= Math.max(o, c), `${key} candle ${i / 4} is not a valid candle`);
    }
  }
});

test("a forecast never reads candles after its origin", () => {
  const candles = walk(500);
  const origin = 300;
  const altered = candles.map((k, i) => i > origin ? { ...k, o: k.o * 3, h: k.h * 3, l: k.l * 3, c: k.c * 3 } : k);
  for (const { key } of MODELS) {
    const a = simulate(prepare(candles), { model: key, origin, horizon: 30, paths: 40 });
    const b = simulate(prepare(altered), { model: key, origin, horizon: 30, paths: 40 });
    assert.deepEqual(a.candles, b.candles, key);
  }
});

test("analog matches only use windows whose whole future is known, nearest first", () => {
  const prep = prepare(walk(400));
  const origin = 399, horizon = 25, window = 12;
  const matches = findAnalogs(prep, { origin, window, horizon, count: 30 });
  assert.equal(matches.length, 30);
  assert.ok(matches.every(m => m.end + horizon <= origin && m.end >= window));
  assert.ok(matches.every((m, i) => i === 0 || m.distance >= matches[i - 1].distance));
  assert.ok(Math.abs(matches.reduce((s, m) => s + m.weight, 0) - 1) < 1e-9);
});

test("an exact repeat of the current pattern is the nearest match", () => {
  const candles = walk(300, 5);
  const copy = candles.slice(100, 112).map(k => k);
  const tail = candles.slice(0, 288);
  let scale = tail.at(-1).c / candles[99].c;
  for (const k of copy) tail.push({ ...k, t: tail.length * 60000, o: k.o * scale, h: k.h * scale, l: k.l * scale, c: k.c * scale });
  const prep = prepare(tail);
  const [best] = findAnalogs(prep, { origin: prep.n - 1, window: 12, horizon: 10, count: 10 });
  assert.equal(best.end, 111);
});

test("quantile interpolates and crps rewards sharp, centred forecasts", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.9), 5);
  assert.ok(Math.abs(crps([0, 0, 0], 1) - 1) < 1e-12, "a point forecast's CRPS is its absolute error");
  const wide = Array.from({ length: 101 }, (_, i) => -5 + i / 10);
  const tight = Array.from({ length: 101 }, (_, i) => -0.5 + i / 100);
  assert.ok(crps(tight, 0) < crps(wide, 0));
});

test("fan quantiles are ordered and start near the last close", () => {
  const prep = prepare(walk(400));
  const rows = fan(simulate(prep, { model: "bootstrap", horizon: 15, paths: 300 }));
  assert.equal(rows.length, 15);
  for (const r of rows) assert.ok(r.q[0.05] <= r.q[0.25] && r.q[0.25] <= r.q[0.5] && r.q[0.5] <= r.q[0.75] && r.q[0.75] <= r.q[0.95]);
  assert.ok(rows[0].q[0.95] - rows[0].q[0.05] < rows[14].q[0.95] - rows[14].q[0.05], "uncertainty widens with the horizon");
});

test("on a pure random walk the random walk's bands are honest and nothing has real skill", () => {
  const prep = prepare(walk(3000, 11));
  const { results, origins } = backtest(prep, { horizon: 10, maxOrigins: 250 });
  assert.ok(origins.length >= 200);
  assert.ok(Math.abs(results.gaussian.coverage90 - 0.9) < 0.07, `coverage90 ${results.gaussian.coverage90}`);
  assert.ok(Math.abs(results.gaussian.coverage50 - 0.5) < 0.1, `coverage50 ${results.gaussian.coverage50}`);
  assert.ok(Math.abs(results.gaussian.below5 + results.gaussian.above95 + results.gaussian.coverage90 - 1) < 1e-9);
  for (const key of ["bootstrap", "garch", "analog"]) {
    const r = results[key];
    assert.ok(r.skill - 3 * r.skillSE < 0, `${key} claims skill ${r.skill} ± ${r.skillSE} on noise`);
  }
});

test("market.json closes become weekday candles ending on the build date", () => {
  const candles = marketJsonCandles({ asOf: "2026-09-11T20:00:00+00:00", historicalSeries: [10, 11, 12] });
  assert.deepEqual(candles.map(k => new Date(k.t).toISOString().slice(0, 10)), ["2026-09-09", "2026-09-10", "2026-09-11"]);
  assert.deepEqual(candles.map(k => k.o), [10, 10, 11]);
});

test("matches from another series replay that series' moves, resized to this series' volatility", () => {
  const here = prepare(walk(300, 1, 0.01));
  const there = prepare(walk(300, 2, 0.03));
  const sim = simulate(here, { model: "engine", horizon: 5, paths: 3, matches: [{ prep: there, end: 100, weight: 1 }] });
  const scale = here.nextSigma / there.sigma[101];
  let pc = here.candles.at(-1).c;
  for (let k = 0; k < 5; k++) {
    pc *= Math.exp(there.rel[4 * (101 + k) + 3] * scale);
    assert.ok(Math.abs(sim.candles[k * 4 + 3] / pc - 1) < 1e-9);
  }
  const { results } = backtest(here, { models: ["gaussian", "engine"], horizon: 5, maxOrigins: 5, external: { engine: () => ({ matches: [] }) } });
  assert.equal(results.engine.n, 5, "an empty match list falls back to the bootstrap instead of failing");
});

test("the likely path is the run that stays in the crowded middle, not an outlier", () => {
  const horizon = 10, paths = 201;
  const candles = new Float64Array(paths * horizon * 4);
  // Paths fan out around 100, packed tightly near path 100 and thinning towards the edges (cubic spacing).
  for (let p = 0; p < paths; p++) {
    for (let k = 0; k < horizon; k++) {
      const c = 100 * Math.exp(0.2 * ((p - 100) / 100) ** 3 * (k + 1) / horizon);
      candles.set([c, c, c, c], (p * horizon + k) * 4);
    }
  }
  const sim = { start: 100, horizon, paths, candles };
  const best = likelyPath(sim);
  assert.ok(Math.abs(best - 100) <= 10, `picked path ${best}`);
  const prep = prepare(walk(500));
  const real = simulate(prep, { model: "bootstrap", horizon: 20, paths: 400 });
  const pick = likelyPath(real);
  const rows = fan(real);
  for (let k = 0; k < 20; k++) {
    const c = real.candles[(pick * 20 + k) * 4 + 3];
    assert.ok(c >= rows[k].q[0.05] && c <= rows[k].q[0.95], `step ${k + 1} leaves the 90% band`);
  }
});

test("a bootstrap drift tilts every path by that much per candle", () => {
  const prep = prepare(walk(400));
  const flat = simulate(prep, { model: "bootstrap", horizon: 10, paths: 50, seed: 4 });
  const tilted = simulate(prep, { model: "bootstrap", horizon: 10, paths: 50, seed: 4, drift: 0.001 });
  for (let p = 0; p < 50; p++) {
    const at = (p * 10 + 9) * 4 + 3;
    assert.ok(Math.abs(Math.log(tilted.candles[at] / flat.candles[at]) - 0.01) < 1e-9, "ten candles of 0.1% each");
  }
});

/** Closes from a GJR-GARCH(1,1) process with the given parameters and a fixed seed. */
function gjrWalk(n, { omega, alpha, gamma, beta }, seed = 5) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  let v = omega / (1 - alpha - gamma / 2 - beta), c = 100;
  const candles = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(v) * gauss();
    candles.push({ t: i * 86400000, c: c *= Math.exp(r) });
    v = omega + (alpha + (r < 0 ? gamma : 0)) * r * r + beta * v;
  }
  return candles;
}

test("the GJR-GARCH fit finds a planted leverage effect, and none in a symmetric walk", () => {
  const fit = fitGjr(prepare(gjrWalk(4000, { omega: 2e-6, alpha: 0.02, gamma: 0.15, beta: 0.88 })));
  assert.ok(fit.gamma > 0.07 && fit.gamma > 3 * fit.alpha, `gamma ${fit.gamma}, alpha ${fit.alpha}`);
  assert.ok(Math.abs(fit.alpha + fit.gamma / 2 + fit.beta - 0.975) < 0.03, "persistence");
  const flat = fitGjr(prepare(walk(4000, 8)));
  assert.ok(flat.gamma < 0.05, `gamma ${flat.gamma} on a symmetric walk`);
  assert.equal(fitGjr(prepare(walk(100))), null, "too little history to fit");
});

test("the GJR-GARCH fit at an origin reads no later candles", () => {
  const candles = gjrWalk(800, { omega: 2e-6, alpha: 0.02, gamma: 0.15, beta: 0.88 });
  const a = fitGjr(prepare(candles), 500);
  const b = fitGjr(prepare(candles.slice(0, 501)), 500);
  assert.deepEqual(a, b);
});

test("garch paths fade a volatility spike back toward the long-run level; the EWMA's do not", () => {
  // A calm series that ends in a burst of large moves.
  const candles = walk(1500, 2, 0.01);
  let c = candles.at(-1).c;
  for (let i = 0; i < 10; i++) candles.push({ t: (1500 + i) * 60000, c: c *= Math.exp(i % 2 ? 0.05 : -0.05) });
  const prep = prepare(candles);
  const spread = (sim, k) => {
    const logs = Array.from({ length: sim.paths }, (_, p) => Math.log(sim.candles[(p * sim.horizon + k) * 4 + 3] / sim.candles[(p * sim.horizon + k - 1) * 4 + 3]));
    return Math.sqrt(logs.reduce((s, x) => s + x * x, 0) / logs.length);
  };
  const garch = simulate(prep, { model: "garch", horizon: 120, paths: 400, seed: 3 });
  const ewma = simulate(prep, { model: "bootstrap", horizon: 120, paths: 400, seed: 3 });
  assert.ok(spread(garch, 119) < 0.7 * spread(garch, 1), "garch volatility decays over the horizon");
  assert.ok(spread(ewma, 119) > 0.7 * spread(ewma, 1), "the EWMA has no pull back to normal");
});

/** Weekday daily candles from 2024-01-01 (a Monday) with a ±12% gap on every `every`th session, the rest calm. */
function withGaps(n, every = 63, seed = 6) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const candles = [], gaps = [];
  let c = 100, t = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    while ([0, 6].includes(new Date(t).getUTCDay())) t += 86400000;
    const jump = i > 0 && i % every === 0;
    if (jump) gaps.push(new Date(t).toISOString().slice(0, 10));
    c *= Math.exp(jump ? (gaps.length % 2 ? 0.12 : -0.12) : 0.01 * gauss());
    candles.push({ t, c });
    t += 86400000;
  }
  return { candles, gaps };
}

test("earnings dates map onto the session that reacted, split around the origin", () => {
  const { candles, gaps } = withGaps(700);
  const prep = prepare(candles);
  const origin = 600;
  const events = earningsEvents(prep, { from: "2024-01-01", dates: gaps }, origin, 30);
  assert.deepEqual(events.past, [63, 126, 189, 252, 315, 378, 441, 504, 567]);
  assert.deepEqual(events.ahead, [630 - origin - 1]);
  // A Saturday release reacts on Monday; a date after the last candle counts weekdays from it.
  const last = new Date(candles.at(-1).t);
  assert.equal(last.getUTCDay(), 5, "the series ends on a Friday");
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const monday = events.past.find(i => new Date(candles[i].t).getUTCDay() === 1);
  const dates = gaps.map(d => d === iso(candles[monday].t) ? iso(candles[monday].t - 2 * 86400000) : d);
  const nextTuesday = iso(last.getTime() + 4 * 86400000);
  const shifted = earningsEvents(prep, { from: "2024-01-01", dates: [...dates, nextTuesday] }, prep.n - 1, 10);
  assert.ok(shifted.past.includes(monday), "a Saturday release reacts on Monday");
  assert.deepEqual(shifted.ahead, [1], "the weekend is skipped: Monday, then Tuesday is the second step");
  assert.equal(earningsEvents(prep, { from: "2025-10-01", dates: gaps }, origin, 30), null, "too few releases inside the covered span");
});

test("earnings gaps land on their scheduled step and nowhere else", () => {
  const { candles, gaps } = withGaps(700);
  const prep = prepare(candles);
  const origin = 600, horizon = 40;
  const events = earningsEvents(prep, { from: "2024-01-01", dates: gaps }, origin, horizon);
  const step = events.ahead[0];
  const spread = (sim, k) => {
    const prev = (p) => k ? sim.candles[(p * horizon + k - 1) * 4 + 3] : sim.start;
    const logs = Array.from({ length: sim.paths }, (_, p) => Math.abs(Math.log(sim.candles[(p * horizon + k) * 4 + 3] / prev(p))));
    return Math.max(...logs);
  };
  for (const model of ["garch", "bootstrap"]) {
    const sim = simulate(prep, { model, origin, horizon, paths: 300, seed: 2, earnings: events });
    assert.ok(spread(sim, step) > 0.08, `${model}: the gap is replayed on its date`);
    for (let k = 0; k < horizon; k++) if (k !== step) assert.ok(spread(sim, k) < 0.06, `${model}: no gap on step ${k}`);
    // Without the schedule the gaps are ordinary library candles and turn up anywhere.
    const plain = simulate(prep, { model, origin, horizon, paths: 300, seed: 2 });
    assert.ok(Array.from({ length: horizon }, (_, k) => k).filter(k => k !== step).some(k => spread(plain, k) > 0.06), model);
  }
});

test("the GJR-GARCH fit leaves scheduled jumps out", () => {
  const { candles, gaps } = withGaps(1200);
  const prep = prepare(candles);
  const events = earningsEvents(prep, { from: "2024-01-01", dates: gaps }, prep.n - 1, 1);
  const withJumps = fitGjr(prep), without = fitGjr(prep, prep.n - 1, new Set(events.past));
  const longRun = (f) => Math.sqrt(f.omega / (1 - f.alpha - f.gamma / 2 - f.beta));
  assert.ok(Math.abs(longRun(without) - 0.01) < 0.001, `long-run vol ${longRun(without)} is the calm days' 1%`);
  assert.ok(longRun(withJumps) > 0.013, "the gaps inflate it when left in");
});
