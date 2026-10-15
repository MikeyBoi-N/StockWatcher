/**
 * Price simulator: the math behind simulator.html.
 *
 * Nothing here predicts one future. Every model turns the candles seen so far into a few hundred simulated
 * futures, and the page draws their spread. Three models, from dumbest to most opinionated:
 *
 *   gaussian   A random walk at today's volatility. No memory, no patterns. The baseline every other model must beat.
 *   bootstrap  Replays real past candles (wicks, gaps and crash-sized moves included) in short blocks, rescaled from
 *              the volatility they happened at to today's. Volatility updates along each path, so calm and wild
 *              stretches cluster the way they do in real markets. Knows the market's texture, not its direction.
 *   analog     Pattern matching. Finds the past moments whose last few candles looked most like the last few now,
 *              and replays what happened after each one. This is the "patterns are real" hypothesis: if chart
 *              shapes carry information, these futures lean the right way more often than the bootstrap's.
 *
 * Candles are compared and replayed in units of their own volatility: a candle relative to the previous close, as
 * log moves, divided by the EWMA volatility known before it opened. That makes a 2% day in a calm month and a 2% day
 * in a panic different shapes, and lets a pattern from a quiet week match one from a loud week.
 *
 * Everything is causal: a simulation from origin t reads only candles 0..t, so backtest() can replay any past
 * origin as if it were live and score the forecast against what came next. Randomness comes from a seeded
 * generator, so the same inputs always draw the same futures.
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const MODELS = [
  { key: "analog", label: "Pattern analogs" },
  { key: "bootstrap", label: "Historical bootstrap" },
  { key: "gaussian", label: "Random walk" }
];

/** RiskMetrics decay: today's volatility estimate keeps 94% of yesterday's and takes 6% from the latest move. */
const EWMA_LAMBDA = 0.94;
const MIN_SIGMA = 1e-6;
/** Mean block length for the bootstrap, in candles. */
const BLOCK_LENGTH = 8;
/** Candles of volume history a pattern's relative volume is measured against. */
const VOLUME_LOOKBACK = 50;
/** Share of paths that must agree on a direction before the backtest counts it as a call. */
const CALL_SHARE = 0.6;

/** Seeded uniform [0, 1) generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand) {
  const u = 1 - rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Cleans candles and precomputes each one's move relative to the previous close and the volatility known before it.
 * Input: [{ t, o, h, l, c, v? }] in time order. Candles with a missing or non-positive price are dropped; a high or
 * low that does not contain the open and close is widened to contain them. Candles without an open (closes-only
 * data) open at the previous close.
 * Output: { candles, n, rel, sigma, nextSigma, hasVolume }
 *   rel[4i..4i+3]  log(open, high, low, close / previous close) of candle i (zeros for candle 0)
 *   sigma[i]       volatility forecast for candle i, made at the close of candle i-1
 *   nextSigma      the forecast for the candle after the last one
 *   volume[i]      log of candle i's volume over the median of the 50 before it, clamped to ±3 (zeros without volume)
 */
export function prepare(raw) {
  const candles = [];
  for (const k of raw) {
    if (!isNum(k.c) || k.c <= 0) continue;
    const prev = candles.length ? candles[candles.length - 1].c : k.c;
    const o = isNum(k.o) && k.o > 0 ? k.o : prev;
    const h = Math.max(isNum(k.h) ? k.h : 0, o, k.c);
    const l = Math.min(isNum(k.l) && k.l > 0 ? k.l : Infinity, o, k.c);
    candles.push({ t: k.t, o, h, l, c: k.c, v: isNum(k.v) && k.v >= 0 ? k.v : null });
  }
  const n = candles.length;
  if (n < 3) throw new Error(`Need at least 3 candles to simulate, got ${n}`);

  const rel = new Float64Array(n * 4);
  for (let i = 1; i < n; i++) {
    const pc = candles[i - 1].c, k = candles[i];
    rel[4 * i] = Math.log(k.o / pc);
    rel[4 * i + 1] = Math.log(k.h / pc);
    rel[4 * i + 2] = Math.log(k.l / pc);
    rel[4 * i + 3] = Math.log(k.c / pc);
  }

  const seedCount = Math.min(30, n - 1);
  let variance = 0;
  for (let i = 1; i <= seedCount; i++) variance += rel[4 * i + 3] ** 2;
  variance /= seedCount;
  const sigma = new Float64Array(n);
  sigma[0] = Math.max(Math.sqrt(variance), MIN_SIGMA);
  for (let i = 1; i < n; i++) {
    sigma[i] = Math.max(Math.sqrt(variance), MIN_SIGMA);
    variance = EWMA_LAMBDA * variance + (1 - EWMA_LAMBDA) * rel[4 * i + 3] ** 2;
  }
  const hasVolume = candles.filter(k => k.v > 0).length > n * 0.9;
  const volume = new Float64Array(n);
  if (hasVolume) {
    for (let i = 0; i < n; i++) {
      const recent = candles.slice(Math.max(0, i - VOLUME_LOOKBACK), i + 1).map(k => k.v ?? 0).sort((a, b) => a - b);
      const median = recent[recent.length >> 1];
      volume[i] = Math.max(-3, Math.min(3, Math.log(((candles[i].v ?? 0) + 1e-9) / (median + 1e-9))));
    }
  }
  return { candles, n, rel, sigma, nextSigma: Math.max(Math.sqrt(variance), MIN_SIGMA), hasVolume, volume };
}

/** Volatility forecast for the candle after `origin`. */
const sigmaAfter = (prep, origin) => origin + 1 < prep.n ? prep.sigma[origin + 1] : prep.nextSigma;

/** Writes one simulated candle into `out` at slot `at` from log moves relative to `pc`; returns its close. */
function writeCandle(out, at, pc, lo, lh, ll, lc) {
  const o = pc * Math.exp(lo), c = pc * Math.exp(lc);
  out[at] = o;
  out[at + 1] = Math.max(pc * Math.exp(lh), o, c);
  out[at + 2] = Math.min(pc * Math.exp(ll), o, c);
  out[at + 3] = c;
  return c;
}

/**
 * The analog model's search: windows of `window` candles ending at j whose following `horizon` candles are all known
 * at `origin`, ranked by how closely their shape matches the window ending at `origin`.
 * Shape = each candle's close, high and low moves in volatility units (plus volume relative to its recent median,
 * when the data has volume), with the latest candles weighted most.
 * Returns up to `count` matches, nearest first: [{ end, distance, weight }], weights summing to 1.
 */
export function findAnalogs(prep, { origin, window, horizon, count }) {
  const { rel, sigma, volume, hasVolume } = prep;
  const first = window, last = origin - horizon;
  if (last < first) return [];

  const recency = Array.from({ length: window }, (_, k) => (0.5 + 0.5 * (k + 1) / window) ** 2);
  const scored = [];
  for (let j = first; j <= last; j++) {
    let d = 0;
    for (let k = 0; k < window; k++) {
      const i = j - window + 1 + k, o = origin - window + 1 + k;
      const si = sigma[i], so = sigma[o];
      let e = (rel[4 * i + 3] / si - rel[4 * o + 3] / so) ** 2
        + (rel[4 * i + 1] / si - rel[4 * o + 1] / so) ** 2
        + (rel[4 * i + 2] / si - rel[4 * o + 2] / so) ** 2;
      if (hasVolume) e += 0.25 * (volume[i] - volume[o]) ** 2;
      d += recency[k] * e;
    }
    scored.push({ end: j, distance: Math.sqrt(d) });
  }
  scored.sort((a, b) => a.distance - b.distance);
  const top = scored.slice(0, Math.max(1, Math.min(count, Math.floor(scored.length / 3) || 1)));
  const bandwidth = top[top.length >> 1].distance || 1;
  let total = 0;
  for (const m of top) total += (m.weight = Math.exp(-0.5 * (m.distance / bandwidth) ** 2));
  for (const m of top) m.weight /= total;
  return top;
}

/**
 * Simulates `paths` futures of `horizon` candles from the close of candle `origin` (default: the latest).
 * Options: { model, origin, horizon, paths, window (analog pattern length), neighbors (analog matches), seed, matches, drift }
 * `matches` replaces the analog model's own pattern search with matches found elsewhere, possibly in other series:
 * [{ end, weight, prep? }], where `prep` (default: this series) is the prepared series the match's future is read from.
 * `drift` (bootstrap only) tilts every simulated candle by that log return, e.g. a fitted signal's expected edge.
 * Returns { start, horizon, paths, candles: Float64Array(paths * horizon * 4) as o,h,l,c per step, analogs }
 * `analogs` is the match list the paths were drawn from (empty for the other models).
 */
export function simulate(prep, { model = "bootstrap", origin = prep.n - 1, horizon = 30, paths = 500, window = 12, neighbors = 150, seed = 1, matches = null, drift = 0 } = {}) {
  if (origin < 1 || origin >= prep.n) throw new Error(`Origin ${origin} is outside the ${prep.n} candles`);
  const rand = rng(seed);
  const { rel, sigma } = prep;
  const start = prep.candles[origin].c;
  const sigmaNow = sigmaAfter(prep, origin);
  const out = new Float64Array(paths * horizon * 4);
  let analogs = [];

  if (model === "analog" || matches) {
    analogs = matches ?? findAnalogs(prep, { origin, window, horizon, count: neighbors });
    if (!analogs.length) return simulate(prep, { model: "bootstrap", origin, horizon, paths, seed });
    const cumulative = [];
    let acc = 0;
    for (const m of analogs) cumulative.push(acc += m.weight);
    for (let p = 0; p < paths; p++) {
      const u = rand() * acc;
      const m = analogs[Math.min(cumulative.findIndex(c => c >= u), analogs.length - 1)];
      const src = m.prep ?? prep;
      const scale = sigmaNow / src.sigma[m.end + 1];
      let pc = start;
      for (let k = 0; k < horizon; k++) {
        const r = 4 * (m.end + 1 + k), at = (p * horizon + k) * 4;
        pc = writeCandle(out, at, pc, src.rel[r] * scale, src.rel[r + 1] * scale, src.rel[r + 2] * scale, src.rel[r + 3] * scale);
      }
    }
    return { start, horizon, paths, candles: out, analogs };
  }

  if (model === "gaussian") {
    for (let p = 0; p < paths; p++) {
      let pc = start;
      for (let k = 0; k < horizon; k++) {
        const lc = sigmaNow * normal(rand) - 0.5 * sigmaNow ** 2;
        const top = Math.max(0, lc) + 0.4 * sigmaNow * Math.abs(normal(rand));
        const bottom = Math.min(0, lc) - 0.4 * sigmaNow * Math.abs(normal(rand));
        pc = writeCandle(out, (p * horizon + k) * 4, pc, 0, top, bottom, lc);
      }
    }
    return { start, horizon, paths, candles: out, analogs };
  }

  // Bootstrap: library of past candles in volatility units, recentred so the past's drift is not replayed as a forecast.
  const count = origin;
  let meanClose = 0;
  for (let i = 1; i <= origin; i++) meanClose += rel[4 * i + 3] / sigma[i];
  meanClose /= count;
  for (let p = 0; p < paths; p++) {
    let pc = start, s = sigmaNow, i = 1 + Math.floor(rand() * count);
    for (let k = 0; k < horizon; k++) {
      if (k > 0) i = rand() < 1 / BLOCK_LENGTH || i >= origin ? 1 + Math.floor(rand() * count) : i + 1;
      const r = 4 * i, z = s / sigma[i], shift = meanClose * s;
      const lc = rel[r + 3] * z - shift;
      // The drift moves the candle, not the volatility: the update below sees the untilted move.
      pc = writeCandle(out, (p * horizon + k) * 4, pc, rel[r] * z - shift + drift, rel[r + 1] * z - shift + drift, rel[r + 2] * z - shift + drift, lc + drift);
      s = Math.max(Math.sqrt(EWMA_LAMBDA * s * s + (1 - EWMA_LAMBDA) * lc * lc), MIN_SIGMA);
    }
  }
  return { start, horizon, paths, candles: out, analogs };
}

/** Value at quantile q (0..1) of an ascending array, linearly interpolated. */
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * q, lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

/** Simulated closes at step k (0-based), ascending. */
export function closesAt(sim, k) {
  const values = new Float64Array(sim.paths);
  for (let p = 0; p < sim.paths; p++) values[p] = sim.candles[(p * sim.horizon + k) * 4 + 3];
  return values.sort();
}

/** Per-step quantiles of the simulated close: [{ step, q: { [level]: price }, pUp }] with pUp = share above the start. */
export function fan(sim, levels = [0.05, 0.25, 0.5, 0.75, 0.95]) {
  const rows = [];
  for (let k = 0; k < sim.horizon; k++) {
    const sorted = closesAt(sim, k);
    const q = {};
    for (const level of levels) q[level] = quantile(sorted, level);
    let above = 0;
    for (const v of sorted) if (v > sim.start) above++;
    rows.push({ step: k + 1, q, pUp: above / sorted.length });
  }
  return rows;
}

/**
 * The most typical simulated run: the path that stays in the densest part of the cloud from start to finish.
 * At each step, a path's local density is how many of all paths' closes lie within one bandwidth of its own (log
 * price; Silverman's rule on the step's spread), and its score is the sum of those log densities over the steps.
 * Near-ties go to the path closer to the step's median.
 * No single continuous path is "likelier" than another, so this is the best stand-in: a real run, wicks and all,
 * that never strays into the thin tails. It hugs the middle of the fan by construction, so it is not a prediction.
 * Returns the path index.
 */
export function likelyPath(sim) {
  const { paths, horizon, candles } = sim;
  const score = new Float64Array(paths);
  const logs = new Float64Array(paths);
  // Index of the first value at or above x (strict = false) or above x (strict = true) in an ascending array.
  const bound = (a, x, strict) => {
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x || (strict && a[mid] === x)) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (let k = 0; k < horizon; k++) {
    for (let p = 0; p < paths; p++) logs[p] = Math.log(candles[(p * horizon + k) * 4 + 3]);
    const sorted = Float64Array.from(logs).sort();
    const median = quantile(sorted, 0.5);
    const spread = (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / 1.349;
    const h = Math.max(1.06 * spread * paths ** -0.2, 1e-9);
    for (let p = 0; p < paths; p++) {
      const x = logs[p];
      const near = bound(sorted, x + h, true) - bound(sorted, x - h, false);
      score[p] += Math.log(near / paths) - 1e-6 * Math.abs(x - median) / h;
    }
  }
  let best = 0;
  for (let p = 1; p < paths; p++) if (score[p] > score[best]) best = p;
  return best;
}

/**
 * Continuous ranked probability score of a sample forecast against the outcome y (lower is better; same units as y).
 * It rewards forecasts that are both centred on what happened and no wider than they need to be.
 */
export function crps(sorted, y) {
  const m = sorted.length;
  let spread = 0, miss = 0;
  for (let i = 0; i < m; i++) {
    miss += Math.abs(sorted[i] - y);
    spread += (2 * (i + 1) - m - 1) * sorted[i];
  }
  return miss / m - spread / (m * m);
}

/**
 * Walk-forward test: replays past origins as if live, simulates each model from data up to that origin only, and
 * scores the simulated `horizon`-candle return against the one that actually followed.
 * Origins step back from the latest fully-known one by `step` candles (default `horizon`, so test windows never
 * overlap and each origin is an independent check), at most `maxOrigins` of them.
 * A model "calls" a direction when at least 60% of its paths end on one side of the start (with 200 paths, the random
 * walk crosses that by sampling luck well under 1% of the time); each call is filled at the next candle's close (the
 * call needs the origin's close to exist) and pays `costBps` for the round trip (fees on both sides plus the spread).
 * `external` adds models built from outside this series: { [key]: (origin) => simulate() options for that origin },
 * e.g. { matches } from other stocks or { model: "bootstrap", drift } from a fitted signal.
 * Returns { origins, horizon, results: { [model]: metrics } } where metrics are
 *   n, crps (in % log return), skill (vs the random walk, 0 = no better, >0 = better) and skillSE (its standard
 *   error), coverage50, coverage90, brier, trades, hitRate, netPerTrade (% after fees).
 * NaN in a score means the simulation produced a non-finite price, which is a bug, so it throws.
 */
export function backtest(prep, { models = MODELS.map(m => m.key), horizon = 30, paths = 200, window = 12, neighbors = 150, step = horizon, maxOrigins = 120, costBps = 20, seed = 7, external = {} } = {}) {
  const minHistory = Math.max(window + horizon + 20, 40);
  const origins = [];
  for (let t = prep.n - 1 - horizon; t >= minHistory && origins.length < maxOrigins; t -= step) origins.push(t);
  origins.reverse();

  const fee = costBps / 10000;
  const scores = Object.fromEntries(models.map(m => [m, { crps: [], in50: 0, in90: 0, brier: 0, trades: 0, hits: 0, net: 0 }]));
  for (const origin of origins) {
    const realized = Math.log(prep.candles[origin + horizon].c / prep.candles[origin].c);
    // A call is made at the origin's close, so the earliest fill is the next candle's close.
    const traded = horizon > 1 ? Math.log(prep.candles[origin + horizon].c / prep.candles[origin + 1].c) : 0;
    for (const model of models) {
      const extra = external[model] ? external[model](origin) : {};
      const sim = simulate(prep, { model, origin, horizon, paths, window, neighbors, seed: seed + origin, ...extra });
      const sorted = closesAt(sim, horizon - 1).map(v => Math.log(v / sim.start));
      const score = crps(sorted, realized);
      if (!Number.isFinite(score)) throw new Error(`${model} produced a non-finite forecast at origin ${origin}`);
      const s = scores[model];
      s.crps.push(score);
      if (realized >= quantile(sorted, 0.25) && realized <= quantile(sorted, 0.75)) s.in50++;
      if (realized >= quantile(sorted, 0.05) && realized <= quantile(sorted, 0.95)) s.in90++;
      const pUp = sorted.filter(v => v > 0).length / sorted.length;
      s.brier += (pUp - (realized > 0 ? 1 : 0)) ** 2;
      if (pUp >= CALL_SHARE || pUp <= 1 - CALL_SHARE) {
        const side = pUp >= CALL_SHARE ? 1 : -1;
        s.trades++;
        if (side * traded > 0) s.hits++;
        s.net += side * traded - fee;
      }
    }
  }

  const n = origins.length;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const base = scores.gaussian?.crps;
  const results = {};
  for (const model of models) {
    const s = scores[model];
    let skill = null, skillSE = null;
    if (base && n > 1 && model !== "gaussian") {
      const diffs = base.map((b, i) => b - s.crps[i]);
      const baseMean = mean(base), diffMean = mean(diffs);
      const sd = Math.sqrt(diffs.reduce((acc, d) => acc + (d - diffMean) ** 2, 0) / (n - 1));
      skill = diffMean / baseMean;
      skillSE = sd / Math.sqrt(n) / baseMean;
    }
    results[model] = {
      n,
      crps: n ? 100 * mean(s.crps) : null,
      skill, skillSE,
      coverage50: n ? s.in50 / n : null,
      coverage90: n ? s.in90 / n : null,
      brier: n ? s.brier / n : null,
      trades: s.trades,
      hitRate: s.trades ? s.hits / s.trades : null,
      netPerTrade: s.trades ? 100 * s.net / s.trades : null
    };
  }
  return { origins, horizon, results };
}
