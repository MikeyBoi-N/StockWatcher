/**
 * Signals and the fitted model: which replayed measurements ranked next month's winners, and a model fitted to them.
 *
 * Every week of data/replay.json becomes a cross-section: for each stock, a set of signals (the engine's scores plus
 * price signals with published evidence behind them) and the return over the benchmark that followed (SPY, or SPY
 * scaled by the stock's beta; see BENCHMARKS in js/replay.js). Signals are converted to
 * ranks within each week (-√3..√3, so every signal has unit variance and an outlier can't dominate), because what
 * matters for picking stocks is which ones did better than the others that week, not the level of the market.
 *
 * The fitted model is a ridge regression of the next window's return (winsorized and demeaned within each week) on
 * those ranks. walkForward() tests it honestly: at each test date it is refitted on weeks whose whole outcome window
 * had ended before that date, then scored on that date only. makePredictor() gives the simulator the same model as
 * of any origin, for the "Fitted signal" forecast.
 *
 * Fundamentals, revisions and earnings dates are not in the replay (they can't be rebuilt for past dates); the
 * snapshot history collects them going forward.
 */
import { excessReturn, spearman, testDates } from "./replay.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const ratio = (a, b) => isNum(a) && isNum(b) && b > -1 ? (1 + a) / (1 + b) - 1 : null;
const rel = (a, b) => isNum(a) && isNum(b) && b > 0 ? a / b - 1 : null;

export const FITTED_MODEL = { key: "fitted", label: "Fitted signal" };

/** `fit: false` signals are reported but left out of the model (Overall is a blend of the other three scores). */
export const SIGNALS = [
  { key: "overall", group: "Engine", label: "Overall score", value: (s) => s.overall, fit: false },
  { key: "trend", group: "Engine", label: "Trend score", value: (s) => s.trend },
  { key: "entry", group: "Engine", label: "Entry score", value: (s) => s.entry },
  { key: "trade", group: "Engine", label: "Trade score (price part)", value: (s) => s.trade },
  { key: "momentum", group: "Known signals", label: "12-month momentum, skipping the last month", value: (s) => ratio(s.inputs.return12m, s.inputs.return1m) },
  { key: "month", group: "Known signals", label: "Last month's return", value: (s) => s.inputs.return1m },
  { key: "week", group: "Known signals", label: "Last week's return", value: (s) => s.inputs.return5d },
  { key: "volatility", group: "Known signals", label: "30-day volatility", value: (s) => s.inputs.hv30 },
  { key: "high52", group: "Known signals", label: "Closeness to the 52-week high", value: (s) => rel(s.inputs.price, s.inputs.high52) },
  { key: "sma200", group: "Known signals", label: "Distance above the 200-day SMA", value: (s) => rel(s.inputs.price, s.inputs.sma200) },
  { key: "rsi", group: "Known signals", label: "RSI (14)", value: (s) => s.inputs.rsi14 },
  { key: "volume", group: "Known signals", label: "Volume vs its 20-day average", value: (s) => isNum(s.inputs.volume) && s.inputs.avgVolume20 > 0 && s.inputs.volume > 0 ? Math.log(s.inputs.volume / s.inputs.avgVolume20) : null }
];
const FIT_KEYS = SIGNALS.filter(s => s.fit !== false).map(s => s.key);

/** Ridge strength per training row: enough to keep twelve correlated signals from fighting, small next to the data. */
const RIDGE = 0.05;
/** A year of weekly cross-sections before the model is trusted to predict anything. */
const MIN_TRAIN_DATES = 52;
const SQRT3 = Math.sqrt(3);

/** Ranks of `values` scaled to -√3..√3 (ties share their mean rank); nulls stay null. */
function rankScores(values) {
  const present = values.map((v, i) => [v, i]).filter(([v]) => isNum(v)).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(null);
  const n = present.length;
  for (let a = 0; a < n;) {
    let b = a;
    while (b + 1 < n && present[b + 1][0] === present[a][0]) b++;
    const score = n > 1 ? SQRT3 * (2 * ((a + b) / 2) / (n - 1) - 1) : 0;
    for (let k = a; k <= b; k++) out[present[k][1]] = score;
    a = b + 1;
  }
  return out;
}

/**
 * Weekly cross-sections of stocks (ETFs excluded) for one outcome window.
 * @param include (ticker) => boolean, which stocks take part
 * @param benchmark a BENCHMARKS key (js/replay.js): what `excess` is measured against
 * Returns { sessions, dates: [{ t, si, rows: [{ ticker, state, ranks: {key: score|null}, x: Float64Array, excess, y }] }] }
 * oldest first. `excess` is the return over the benchmark `sessions` later (null when not known yet); `y` is that excess
 * clipped to the week's 5th–95th percentile and demeaned within the week, the model's target.
 */
export function buildPanel(replay, states, { sessions = 21, include = () => true, benchmark = "beta" } = {}) {
  const spy = replay.tickers.SPY;
  const spyIndex = new Map(spy.candles.map((k, i) => [k.t, i]));
  const byDate = new Map();
  for (const s of states) {
    if (s.etf || !include(s.ticker) || !spyIndex.has(s.t)) continue;
    if (!byDate.has(s.t)) byDate.set(s.t, []);
    byDate.get(s.t).push(s);
  }
  const dates = [];
  for (const t of [...byDate.keys()].sort((a, b) => a - b)) {
    const list = byDate.get(t), si = spyIndex.get(t);
    const ranks = Object.fromEntries(SIGNALS.map(sig => [sig.key, rankScores(list.map(s => {
      const v = sig.value(s);
      return isNum(v) ? v : null;
    }))]));
    const m = si + sessions < spy.candles.length ? spy.candles[si + sessions].c / spy.candles[si].c - 1 : null;
    const rows = list.map((s, k) => {
      const candles = replay.tickers[s.ticker].candles;
      const r = m !== null && s.i + sessions < candles.length ? candles[s.i + sessions].c / candles[s.i].c - 1 : null;
      const rowRanks = Object.fromEntries(SIGNALS.map(sig => [sig.key, ranks[sig.key][k]]));
      return {
        ticker: s.ticker, state: s, ranks: rowRanks,
        x: Float64Array.from(FIT_KEYS, key => rowRanks[key] ?? 0),
        excess: r === null ? null : excessReturn(r, m, s.beta, benchmark), y: null
      };
    });
    const known = rows.filter(r => r.excess !== null).map(r => r.excess).sort((a, b) => a - b);
    if (known.length >= 5) {
      const lo = known[Math.floor(0.05 * (known.length - 1))], hi = known[Math.ceil(0.95 * (known.length - 1))];
      const clipped = rows.map(r => r.excess === null ? null : Math.min(hi, Math.max(lo, r.excess)));
      const mean = clipped.filter(isNum).reduce((a, b) => a + b, 0) / known.length;
      rows.forEach((r, k) => { if (clipped[k] !== null) r.y = clipped[k] - mean; });
    }
    dates.push({ t, si, rows });
  }
  return { sessions, dates };
}

/** Solves A x = b for a small dense symmetric system (Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    if (Math.abs(M[r][r]) < 1e-12) continue;
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Ridge fit on every row of `dates` with a known target. Returns { beta, rows, dates } or null with too little data.
 * A non-finite coefficient means the data fed in was corrupt, so it throws instead of predicting with it.
 */
export function fitRidge(dates) {
  const K = FIT_KEYS.length;
  const A = Array.from({ length: K }, () => new Array(K).fill(0));
  const b = new Array(K).fill(0);
  let rows = 0, used = 0;
  for (const d of dates) {
    let any = false;
    for (const r of d.rows) {
      if (r.y === null) continue;
      any = true;
      rows++;
      for (let i = 0; i < K; i++) {
        b[i] += r.x[i] * r.y;
        for (let j = i; j < K; j++) A[i][j] += r.x[i] * r.x[j];
      }
    }
    if (any) used++;
  }
  if (used < MIN_TRAIN_DATES) return null;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < i; j++) A[i][j] = A[j][i];
    A[i][i] += RIDGE * rows;
  }
  const beta = solve(A, b);
  if (!beta.every(Number.isFinite)) throw new Error("Fitted signal: non-finite coefficient; check the replay data");
  return { beta, rows, dates: used };
}

const predict = (fit, row) => fit.beta.reduce((s, w, i) => s + w * row.x[i], 0);

/** Mean and standard error. */
function meanSE(values) {
  const n = values.length;
  if (!n) return { mean: null, se: null, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return { mean, se: n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n) : null, n };
}

/** Per-date rank correlation and top-minus-bottom-fifth spread of `score(row)` against the excess return. */
function rankStats(dates, score) {
  const ics = [], spreads = [], tops = [];
  for (const d of dates) {
    const rows = d.rows.filter(r => r.excess !== null && isNum(score(r)));
    const ic = spearman(rows.map(score), rows.map(r => r.excess));
    if (ic !== null) ics.push(ic);
    if (rows.length >= 10) {
      const sorted = [...rows].sort((a, b) => score(a) - score(b));
      const fifth = Math.floor(sorted.length / 5);
      const avg = (list) => list.reduce((s, r) => s + r.excess, 0) / list.length;
      spreads.push(avg(sorted.slice(-fifth)) - avg(sorted.slice(0, fifth)));
      tops.push(avg(sorted.slice(-fifth)));
    }
  }
  return { ic: meanSE(ics), spread: meanSE(spreads), top: meanSE(tops) };
}

/** Test dates for a panel: one per outcome window, newest complete first, so no two windows overlap. */
const panelTestDates = (panel) => {
  const picked = new Set(testDates(panel.dates.filter(d => d.rows.some(r => r.excess !== null)).map(d => d.t), panel.sessions));
  return panel.dates.filter(d => picked.has(d.t));
};

/** Each signal on its own, on the independent test dates: { [key]: { ic, spread, top } }. */
export function signalStats(panel) {
  const dates = panelTestDates(panel);
  return Object.fromEntries(SIGNALS.map(sig => [sig.key, rankStats(dates, r => r.ranks[sig.key])]));
}

/** Index of the last panel date whose outcome window had ended by SPY candle `si`. */
const trainingEnd = (panel, si) => {
  let k = -1;
  for (let i = 0; i < panel.dates.length && panel.dates[i].si + panel.sessions <= si; i++) k = i;
  return k;
};

/**
 * The fitted model, tested walk-forward on the independent test dates: refitted before each one on weeks whose
 * whole outcome window had ended, then scored on that date. Returns { tested, ic, spread, top, final } where `top` is
 * the top fifth's average return over the benchmark, and `final` is the fit on all complete weeks: { weights: [{ key, label,
 * effect }] } with `effect` the modelled return gap between the top- and bottom-ranked stock on that signal alone.
 */
export function walkForward(panel) {
  const tests = panelTestDates(panel);
  const scored = [];
  for (const d of tests) {
    const fit = fitRidge(panel.dates.slice(0, trainingEnd(panel, d.si) + 1));
    if (!fit) continue;
    for (const r of d.rows) r.fitted = predict(fit, r);
    scored.push(d);
  }
  const stats = rankStats(scored, r => r.fitted);
  const all = fitRidge(panel.dates);
  const weights = all ? FIT_KEYS.map((key, i) => ({ key, label: SIGNALS.find(s => s.key === key).label, effect: all.beta[i] * 2 * SQRT3 }))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)) : [];
  return { tested: scored.length, ...stats, final: { weights } };
}

/**
 * The model as it stood at any moment, for the simulator. predict(ticker, t) fits on weeks whose outcome window had
 * ended by time t and returns the stock's predicted return over the others for the next `panel.sessions` sessions,
 * from its latest replayed week at or before t; null without a reading or with too little history. Fits are cached
 * per training cutoff.
 */
export function makePredictor(panel) {
  const fits = new Map();
  return (ticker, t) => {
    let k = -1;
    for (let i = 0; i < panel.dates.length && panel.dates[i].t <= t; i++) k = i;
    if (k < 0) return null;
    const end = trainingEnd(panel, panel.dates[k].si);
    if (!fits.has(end)) fits.set(end, fitRidge(panel.dates.slice(0, end + 1)));
    const fit = fits.get(end);
    if (!fit) return null;
    for (let i = k; i >= 0 && i > k - 2; i--) {
      const row = panel.dates[i].rows.find(r => r.ticker === ticker);
      if (row) return predict(fit, row);
    }
    return null;
  };
}
