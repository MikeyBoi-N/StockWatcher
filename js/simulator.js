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
 *   garch      The bootstrap with GJR-GARCH volatility (fitGjr) instead of the EWMA: drops raise volatility more than
 *              rises, and volatility drifts back toward its long-run level instead of staying wherever it last was.
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
  { key: "garch", label: "Bootstrap, GJR-GARCH vol" },
  { key: "gaussian", label: "Random walk" }
];

/** GARCH with scheduled earnings gaps. Needs a stock's earnings history from outside the candles, so callers offer it. */
export const EARNINGS_MODEL = { key: "earnings", label: "GARCH + earnings gaps" };

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

/**
 * Minimizes f over R^d from `start` (Nelder-Mead). f may return Infinity to reject a point. Deterministic.
 * Returns the best point found.
 */
function nelderMead(f, start, { step = 0.02, iterations = 300, tolerance = 1e-9 } = {}) {
  let simplex = [start, ...start.map((_, i) => start.map((v, j) => j === i ? v + step : v))].map(x => ({ x, y: f(x) }));
  const blend = (a, b, t) => a.map((v, i) => v + t * (b[i] - v));
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.y - b.y);
    const best = simplex[0], worst = simplex.at(-1), second = simplex.at(-2);
    if (Math.abs(worst.y - best.y) <= tolerance * (Math.abs(best.y) + tolerance)) break;
    const centroid = start.map((_, i) => simplex.slice(0, -1).reduce((s, p) => s + p.x[i], 0) / (simplex.length - 1));
    const point = (t) => { const x = blend(centroid, worst.x, t); return { x, y: f(x) }; };
    const reflected = point(-1);
    if (reflected.y < best.y) {
      const expanded = point(-2);
      simplex[simplex.length - 1] = expanded.y < reflected.y ? expanded : reflected;
    } else if (reflected.y < second.y) {
      simplex[simplex.length - 1] = reflected;
    } else {
      const contracted = point(0.5);
      if (contracted.y < worst.y) simplex[simplex.length - 1] = contracted;
      else simplex = simplex.map((p, i) => i === 0 ? p : { x: blend(best.x, p.x, 0.5), y: f(blend(best.x, p.x, 0.5)) });
    }
  }
  return simplex.reduce((a, b) => b.y < a.y ? b : a).x;
}

/** Fewest closes a GJR-GARCH fit is trusted on; with less, the "garch" model falls back to the bootstrap. */
const GARCH_MIN_HISTORY = 120;

/**
 * GJR-GARCH(1,1) fitted to the closes of candles 1..origin (Gaussian quasi-likelihood, demeaned log returns):
 *   σ²[i+1] = ω + (α + γ·[r_i < 0]) r_i² + β σ²[i]
 * γ is the leverage effect: a drop raises tomorrow's volatility more than a rise of the same size. Unlike the EWMA
 * (ω = 0, no γ), the variance is pulled back toward its long-run level ω / (1 − α − γ/2 − β), so a spike fades and a
 * calm spell doesn't last forever. The long-run level is pinned to the sample variance (variance targeting), which
 * keeps the fit stable on a few hundred candles.
 * `jumps` (a Set of candle indices, e.g. earnings reactions) are left out of the fit and do not move the variance:
 * a scheduled gap says nothing about the days around it, so letting it in would inflate α, γ and the long-run level.
 * Returns { omega, alpha, gamma, beta, mean, sigma } where sigma[i] is the forecast for candle i made at the close of
 * candle i-1 (i = 1..origin+1), or null with fewer than GARCH_MIN_HISTORY closes.
 */
export function fitGjr(prep, origin = prep.n - 1, jumps = null) {
  if (origin < GARCH_MIN_HISTORY) return null;
  const { rel } = prep;
  const skip = (i) => jumps !== null && jumps.has(i);
  let mean = 0, count = 0;
  for (let i = 1; i <= origin; i++) if (!skip(i)) { mean += rel[4 * i + 3]; count++; }
  mean /= count;
  const r = new Float64Array(origin + 1);
  let longRun = 0;
  for (let i = 1; i <= origin; i++) {
    r[i] = rel[4 * i + 3] - mean;
    if (!skip(i)) longRun += r[i] ** 2 / count;
  }
  longRun = Math.max(longRun, MIN_SIGMA ** 2);

  const filter = ([alpha, gamma, beta], out) => {
    const omega = longRun * (1 - alpha - gamma / 2 - beta);
    let v = longRun, nll = 0;
    for (let i = 1; i <= origin; i++) {
      if (out) out[i] = Math.sqrt(v);
      if (skip(i)) continue;
      nll += Math.log(v) + r[i] * r[i] / v;
      v = Math.max(omega + (alpha + (r[i] < 0 ? gamma : 0)) * r[i] * r[i] + beta * v, MIN_SIGMA ** 2);
    }
    if (out) out[origin + 1] = Math.sqrt(v);
    return nll;
  };
  const objective = ([alpha, gamma, beta]) => alpha < 0 || gamma < 0 || beta < 0 || alpha + gamma / 2 + beta >= 0.999 ? Infinity : filter([alpha, gamma, beta]);
  const [alpha, gamma, beta] = nelderMead(objective, [0.05, 0.05, 0.85]);
  const sigma = new Float64Array(origin + 2);
  if (!Number.isFinite(filter([alpha, gamma, beta], sigma))) throw new Error("GJR-GARCH fit produced a non-finite likelihood");
  sigma[0] = sigma[1];
  return { omega: longRun * (1 - alpha - gamma / 2 - beta), alpha, gamma, beta, mean, sigma };
}

/**
 * The volatility a GJR-GARCH fit expects over the next `sessions` sessions, annualized: the average of its variance
 * forecasts, which start at tomorrow's and decay toward the long-run level at rate α + γ/2 + β per session. With
 * `earnings` (earningsEvents()), past reactions are left out of the fit and each release ahead adds the stock's
 * average squared reaction in place of an ordinary session, so the figure is comparable with an option's implied
 * volatility, which prices the release too.
 * Returns { vol, diffusive, earningsDays, persistence } or null when the fit has too little history.
 */
export function forecastVolatility(prep, sessions, earnings = null) {
  const origin = prep.n - 1;
  const fit = fitGjr(prep, origin, earnings ? new Set(earnings.past) : null);
  if (!fit || sessions < 1) return null;
  const phi = fit.alpha + fit.gamma / 2 + fit.beta;
  const longRun = fit.omega / (1 - phi);
  const first = fit.sigma[origin + 1] ** 2;
  const diffusive = sessions * longRun + (first - longRun) * (1 - phi ** sessions) / (1 - phi);
  let total = diffusive;
  const releases = earnings?.ahead.filter(k => k < sessions).length ?? 0;
  if (releases) {
    const jump = earnings.past.reduce((s, i) => s + prep.rel[4 * i + 3] ** 2, 0) / earnings.past.length;
    total += releases * Math.max(0, jump - longRun);
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error("GJR-GARCH forecast produced a non-finite variance");
  return {
    vol: Math.sqrt(total / sessions * 252),
    diffusive: Math.sqrt(diffusive / sessions * 252),
    earningsDays: releases,
    persistence: phi
  };
}

/** Fewest past earnings reactions the earnings model draws from; with fewer it has no sense of the stock's gap size. */
const MIN_EARNINGS = 4;

/**
 * Earnings reactions around `origin`, for simulate()'s `earnings` option. Daily candles only.
 * history: { from, dates } with ISO dates of each release's first reacting session, complete from `from` (see
 *   scripts/market_data/earnings.py); a date after the last candle (e.g. the next scheduled release) is placed by
 *   counting weekdays.
 * Returns { past: [candle indices ≤ origin], ahead: [steps 0..horizon-1] } or null when fewer than MIN_EARNINGS
 * reactions are known before the origin.
 * In a backtest `ahead` comes from the actual release dates. Companies announce them weeks ahead, so that is mostly
 * information the forecast could have had; the rare unscheduled pre-announcement is the exception.
 */
export function earningsEvents(prep, history, origin, horizon) {
  const { candles, n } = prep;
  const dayMs = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const coveredFrom = dayMs(history.from);
  const past = new Set(), ahead = new Set();
  let j = 0;
  for (const t of history.dates.map(dayMs).sort((a, b) => a - b)) {
    while (j < n && candles[j].t < t) j++;
    if (j < n) {
      if (j >= 1 && j <= origin && candles[j].t >= coveredFrom) past.add(j);
      else if (j > origin && j - origin <= horizon) ahead.add(j - origin - 1);
      continue;
    }
    let steps = n - 1 - origin;
    for (let d = candles[n - 1].t + 86400000; d <= t && steps <= horizon; d += 86400000) {
      const weekday = new Date(d).getUTCDay();
      if (weekday !== 0 && weekday !== 6) steps++;
    }
    if (steps >= 1 && steps <= horizon) ahead.add(steps - 1);
  }
  return past.size < MIN_EARNINGS ? null : { past: [...past], ahead: [...ahead] };
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
 * `earnings` (bootstrap and garch) schedules earnings gaps, from earningsEvents(): { past, ahead }. Past reactions leave
 * the replay library and the volatility fit; at each step in `ahead`, every path takes one of them instead, drawn at
 * random and resized to the path's volatility, and the volatility update skips it, so the event doesn't leave the
 * days after it looking wild (the realized-price side of the options market's post-earnings "volatility crush").
 * Returns { start, horizon, paths, candles: Float64Array(paths * horizon * 4) as o,h,l,c per step, analogs }
 * `analogs` is the match list the paths were drawn from (empty for the other models).
 */
export function simulate(prep, { model = "bootstrap", origin = prep.n - 1, horizon = 30, paths = 500, window = 12, neighbors = 150, seed = 1, matches = null, drift = 0, earnings = null } = {}) {
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
  // The garch model is the same replay (filtered historical simulation) with GJR-GARCH volatility in place of the EWMA,
  // both for putting the library in volatility units and for updating volatility along each path.
  const jumps = earnings ? new Set(earnings.past) : null;
  const garch = model === "garch" ? fitGjr(prep, origin, jumps) : null;
  if (model === "garch" && !garch) return simulate(prep, { model: "bootstrap", origin, horizon, paths, seed, drift, earnings });
  const ahead = new Set(earnings?.ahead ?? []);
  const vol = garch ? garch.sigma : sigma;
  const nextSigma = garch
    ? (s, lc) => Math.sqrt(garch.omega + (garch.alpha + (lc < 0 ? garch.gamma : 0)) * lc * lc + garch.beta * s * s)
    : (s, lc) => Math.sqrt(EWMA_LAMBDA * s * s + (1 - EWMA_LAMBDA) * lc * lc);
  const count = origin;
  let meanClose = 0, ordinary = 0;
  for (let i = 1; i <= origin; i++) if (!jumps?.has(i)) { meanClose += rel[4 * i + 3] / vol[i]; ordinary++; }
  meanClose /= ordinary;
  // A uniform draw from the library; with earnings scheduled, past reactions are only replayed on their own dates.
  const draw = () => {
    let i;
    do i = 1 + Math.floor(rand() * count); while (jumps?.has(i));
    return i;
  };
  for (let p = 0; p < paths; p++) {
    let pc = start, s = garch ? vol[origin + 1] : sigmaNow, i = draw();
    for (let k = 0; k < horizon; k++) {
      const event = ahead.has(k);
      if (event) i = earnings.past[Math.floor(rand() * earnings.past.length)];
      else if (k > 0) i = rand() < 1 / BLOCK_LENGTH || i >= origin || jumps?.has(i + 1) ? draw() : i + 1;
      const r = 4 * i, z = s / vol[i], shift = meanClose * s;
      const lc = rel[r + 3] * z - shift;
      // The drift moves the candle, not the volatility: the update below sees the untilted move.
      pc = writeCandle(out, (p * horizon + k) * 4, pc, rel[r] * z - shift + drift, rel[r + 1] * z - shift + drift, rel[r + 2] * z - shift + drift, lc + drift);
      if (!event) s = Math.max(nextSigma(s, lc), MIN_SIGMA);
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
 *   error), coverage50, coverage90, below5 and above95 (share of outcomes past each end of the 90% band: a band can
 *   hold 90% overall while missing far more crashes than rallies), brier, brierSkill and brierSkillSE (how much better
 *   its chance of "up" scored than the random walk's, the direction counterpart of skill), trades, hitRate,
 *   netPerTrade (% after fees).
 * NaN in a score means the simulation produced a non-finite price, which is a bug, so it throws.
 */
export function backtest(prep, { models = MODELS.map(m => m.key), horizon = 30, paths = 200, window = 12, neighbors = 150, step = horizon, maxOrigins = 120, costBps = 20, seed = 7, external = {} } = {}) {
  const minHistory = Math.max(window + horizon + 20, 40);
  const origins = [];
  for (let t = prep.n - 1 - horizon; t >= minHistory && origins.length < maxOrigins; t -= step) origins.push(t);
  origins.reverse();

  const fee = costBps / 10000;
  const scores = Object.fromEntries(models.map(m => [m, { crps: [], briers: [], in50: 0, in90: 0, below5: 0, above95: 0, brier: 0, trades: 0, hits: 0, net: 0 }]));
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
      if (realized < quantile(sorted, 0.05)) s.below5++;
      if (realized > quantile(sorted, 0.95)) s.above95++;
      const pUp = sorted.filter(v => v > 0).length / sorted.length;
      s.briers.push((pUp - (realized > 0 ? 1 : 0)) ** 2);
      s.brier += s.briers.at(-1);
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
  /** Improvement over the random walk on a per-origin loss, as a share of its loss, with the standard error of that. */
  const vsRandomWalk = (model, key) => {
    const base = scores.gaussian?.[key];
    if (!base || n < 2 || model === "gaussian") return [null, null];
    const diffs = base.map((b, i) => b - scores[model][key][i]);
    const baseMean = mean(base), diffMean = mean(diffs);
    if (!(baseMean > 0)) return [null, null];
    const sd = Math.sqrt(diffs.reduce((acc, d) => acc + (d - diffMean) ** 2, 0) / (n - 1));
    return [diffMean / baseMean, sd / Math.sqrt(n) / baseMean];
  };
  const results = {};
  for (const model of models) {
    const s = scores[model];
    const [skill, skillSE] = vsRandomWalk(model, "crps");
    const [brierSkill, brierSkillSE] = vsRandomWalk(model, "briers");
    results[model] = {
      n,
      crps: n ? 100 * mean(s.crps) : null,
      skill, skillSE, brierSkill, brierSkillSE,
      coverage50: n ? s.in50 / n : null,
      coverage90: n ? s.in90 / n : null,
      below5: n ? s.below5 / n : null,
      above95: n ? s.above95 / n : null,
      brier: n ? s.brier / n : null,
      trades: s.trades,
      hitRate: s.trades ? s.hits / s.trades : null,
      netPerTrade: s.trades ? 100 * s.net / s.trades : null
    };
  }
  return { origins, horizon, results };
}
