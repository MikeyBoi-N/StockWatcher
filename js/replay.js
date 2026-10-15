/**
 * Engine replay: what the scoring engine (js/engine.js) would have said at the end of each past week, and how it
 * worked out.
 *
 * data/replay.json (scripts/market_data/replay.py) holds five years of daily candles per stock and, for each week,
 * the technical fields the build would have computed from the bars up to that week only. Running the real engine on
 * those rows reproduces its price-based readings with no hindsight: Trend, Entry, the price half of Trade, and the
 * verdicts they lead to. Fundamentals, analyst targets, earnings dates and options can't be rebuilt for past dates,
 * so the engine scores them as missing (Quality is blank and verdicts use the ETF rule for "strong"). The replay
 * therefore tests the engine's price logic, not the whole engine.
 *
 * Uses:
 *   scorecard()      How did each verdict do against SPY over the window that followed? Stocks only, on
 *                    non-overlapping dates so each test is independent. (Scores and other signals: js/signals.js.)
 *   engineMatches()  The "Engine analogs" forecast model: past moments, across every stock, when the engine read the
 *                    market the way it reads this stock now, so the simulator can replay what followed them.
 *
 * How outcomes are measured: total return (dividend-adjusted closes, when the source gives them), bought at the close
 * after the reading (ENTRY_LAG) rather than the close the reading was computed from, which nobody could trade at.
 *
 * Known biases, also stated on the page: every stock in the file exists today. The app's own list is hand-picked and
 * leans towards big winners; the research list is today's S&P 100 members, chosen for being large now, so it is a
 * survivor list too (broader, not unbiased). The replay assumes no earnings were ever inside 14 days.
 */
import { buildMarketContext, evaluateAsset, monthlySigma } from "./engine.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const ENGINE_MODEL = { key: "engine", label: "Engine analogs" };
export const SCORECARD_HORIZONS = [
  { sessions: 5, label: "1 week" },
  { sessions: 21, label: "1 month" },
  { sessions: 63, label: "3 months" }
];
export const BUCKETS = [
  { key: "buy", label: "Buy zone" },
  { key: "strong", label: "Strong asset" },
  { key: "watch", label: "Watch" },
  { key: "avoid", label: "Avoid" }
];
/**
 * What a stock's return is measured against.
 *   spy     Plain SPY. Rewards simply holding more market risk: in a rising market a stock that moves 1.5x the
 *           market beats SPY without any skill.
 *   beta    SPY scaled by the stock's beta (trailingBeta), leaving what the stock did beyond its market exposure.
 *   sector  Risk-adjusted, then compared with the other stocks in the same sector that week, so a sector's run (tech
 *           in 2023-2025) isn't credited to the stocks that happen to be in it. Sectors with fewer than three stocks
 *           that week are compared with the rest of the list instead.
 */
export const BENCHMARKS = [
  { key: "beta", label: "SPY, risk-adjusted" },
  { key: "sector", label: "Sector peers" },
  { key: "spy", label: "SPY" }
];

/** Signals are scored at the close of the reading's day, so the earliest anyone could act is the next close. */
export const ENTRY_LAG = 1;

/** A candle's close for measuring returns: dividend-adjusted when the data has it. */
const totalClose = (k) => k.a ?? k.c;

/**
 * Total return of a position bought ENTRY_LAG sessions after bar i and held `h` sessions, or null past the data.
 */
export const forwardReturn = (candles, i, h) =>
  i + ENTRY_LAG + h < candles.length ? totalClose(candles[i + ENTRY_LAG + h]) / totalClose(candles[i + ENTRY_LAG]) - 1 : null;

/** Return `r` over the benchmark, before any sector comparison, given SPY's return `m` and the stock's beta. */
export const excessReturn = (r, m, beta, benchmark = "beta") =>
  benchmark === "spy" ? (1 + r) / (1 + m) - 1 : r - (Number.isFinite(beta) ? beta : 1) * m;

/**
 * For the sector benchmark: subtracts the week's sector average from each row's `excess` (in place). Rows in sectors
 * with fewer than three stocks that week, or no sector, are compared with the average of those rows instead.
 * Any other benchmark leaves the rows untouched.
 */
export function compareWithSector(rows, benchmark, sectorOf) {
  if (benchmark !== "sector") return rows;
  const groups = new Map();
  for (const r of rows) {
    const key = sectorOf(r) ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const leftovers = [];
  for (const [key, list] of groups) {
    if (key && list.length >= 3) {
      const mean = list.reduce((a, r) => a + r.excess, 0) / list.length;
      for (const r of list) r.excess -= mean;
    } else {
      leftovers.push(...list);
    }
  }
  if (leftovers.length) {
    const mean = leftovers.reduce((a, r) => a + r.excess, 0) / leftovers.length;
    for (const r of leftovers) r.excess -= mean;
  }
  return rows;
}

const BETA_DAYS = 252;
/**
 * Beta of a stock to SPY from up to a year of daily total returns ending at bar i (dates matched to SPY's), shrunk
 * a third of the way towards 1 (Blume's adjustment: a year of data overstates how far betas sit from the market's,
 * and they drift back), or null with fewer than 120 shared days.
 */
export function trailingBeta(candles, i, spyCandles, spyIndex) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let k = Math.max(1, i - BETA_DAYS + 1); k <= i; k++) {
    const a = spyIndex.get(candles[k].t), b = spyIndex.get(candles[k - 1].t);
    if (a === undefined || b === undefined || a !== b + 1) continue;
    const x = Math.log(totalClose(spyCandles[a]) / totalClose(spyCandles[b])), y = Math.log(totalClose(candles[k]) / totalClose(candles[k - 1]));
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  const varX = sxx - sx * sx / n;
  return n >= 120 && varX > 0 ? 0.67 * (sxy - sx * sy / n) / varX + 0.33 : null;
}

/**
 * Which stocks a test covers: the app's tracked list, or that plus the research list (today's S&P 100 members, which
 * is broader but still a list of survivors).
 */
export const UNIVERSES = [
  { key: "tracked", label: "App's list", include: (replay) => (ticker) => !replay.tickers[ticker].research },
  { key: "broad", label: "+ S&P 100 (today's)", include: () => () => true }
];
const REGIME_LEVEL = { BULLISH: 1, NEUTRAL: 0.66, CAUTIOUS: 0.33, BEARISH: 0 };

const dateMs = (yyyymmdd) => Date.UTC(Math.floor(yyyymmdd / 10000), Math.floor(yyyymmdd / 100) % 100 - 1, yyyymmdd % 100);

/**
 * data/replay.json as { generatedAt, tickers: { [ticker]: { etf, sector, research, candles, rows, earnings } } } with candles
 * as [{ t, o, h, l, c, a, v }] (t in UTC ms; `a` the dividend-adjusted close or null) and rows as [{ i, record }],
 * where record is the engine input for bar i.
 */
export function decodeReplay(json) {
  const tickers = {};
  for (const [ticker, raw] of Object.entries(json.tickers ?? {})) {
    const b = raw.bars;
    const candles = b.d.map((d, i) => ({ t: dateMs(d), o: b.o ? b.o[i] : null, h: b.h[i], l: b.l[i], c: b.c[i], a: b.a ? b.a[i] : null, v: b.v[i] }));
    const sector = raw.sector && raw.sector !== "N/A" ? raw.sector : null;
    const rows = raw.rows.map(([i, ...values]) => {
      const record = { ticker, name: ticker, etf: raw.etf, sector, fundamentals: null, valuation: null, catalysts: {}, options: null };
      json.fields.forEach((f, k) => { record[f] = values[k]; });
      return { i, record };
    });
    tickers[ticker] = { etf: raw.etf, sector, research: !!raw.research, candles, rows, earnings: raw.earnings ?? null };
  }
  return { generatedAt: json.generatedAt, tickers };
}

/**
 * Runs the engine on every replayed week. Returns states oldest first:
 *   { ticker, etf, t, i, bucket, verdict, overall, trend, entry, trade, features, inputs, beta }
 * `inputs` is the replayed engine input record (price, SMAs, returns, ...); `beta` is trailingBeta() at that week.
 * `features` places the reading in a common space for engineMatches(): the three scores, the market regime, RSI,
 * stretch above the 50-day and distance to entry support in units of the stock's own volatility, and 3-month
 * strength against SPY.
 */
export function replayStates(replay) {
  const spyCandles = replay.tickers.SPY?.candles ?? [];
  const spyIndex = new Map(spyCandles.map((k, i) => [k.t, i]));
  const byDate = new Map();
  for (const [ticker, s] of Object.entries(replay.tickers)) {
    for (const row of s.rows) {
      const t = s.candles[row.i].t;
      if (!byDate.has(t)) byDate.set(t, []);
      byDate.get(t).push({ ticker, row });
    }
  }
  const states = [];
  for (const t of [...byDate.keys()].sort((a, b) => a - b)) {
    const entries = byDate.get(t);
    const records = entries.map(e => e.row.record);
    if (!records.some(r => r.ticker === "SPY")) continue;
    const context = buildMarketContext(records, {});
    for (const { ticker, row } of entries) {
      const e = evaluateAsset(row.record, context);
      const r = row.record;
      const sigma = monthlySigma(r);
      const spy = context.spy;
      const rel3 = isNum(r.return3m) && isNum(spy?.return3m) ? (1 + r.return3m) / (1 + spy.return3m) - 1 : 0;
      states.push({
        ticker, etf: replay.tickers[ticker].etf, t, i: row.i, inputs: r,
        beta: trailingBeta(replay.tickers[ticker].candles, row.i, spyCandles, spyIndex),
        bucket: e.bucket, verdict: e.verdict, overall: e.overall,
        trend: e.scores.trend.score, entry: e.scores.entry.score, trade: e.scores.trade.score,
        features: [
          e.scores.trend.score / 100,
          e.scores.entry.score / 100,
          e.scores.trade.score / 100,
          REGIME_LEVEL[context.regime] ?? 0.5,
          isNum(r.rsi14) ? r.rsi14 / 100 : 0.5,
          isNum(r.sma50) ? clamp((r.price / r.sma50 - 1) / sigma, -3, 3) / 3 : 0,
          isNum(e.levels.downside) ? clamp(e.levels.downside / (sigma * Math.sqrt(5 / 21)), 0, 4) / 4 : 1,
          clamp(rel3 / (sigma * Math.sqrt(3)), -3, 3) / 3
        ]
      });
    }
  }
  return states;
}


/**
 * The dates to test at, out of `times` (ascending, all with a complete window): one every `sessions` sessions
 * (weekly rows, so weeks rounded up), counting back from the newest, so no two outcome windows overlap.
 */
export function testDates(times, sessions) {
  const stride = Math.max(1, Math.ceil(sessions / 5));
  return times.filter((_, k) => (times.length - 1 - k) % stride === 0);
}

/** Average ranks (1-based), ties sharing the mean of their positions. */
function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let a = 0; a < order.length;) {
    let b = a;
    while (b + 1 < order.length && order[b + 1][0] === order[a][0]) b++;
    for (let k = a; k <= b; k++) out[order[k][1]] = (a + b) / 2 + 1;
    a = b + 1;
  }
  return out;
}

/** Spearman rank correlation, or null with fewer than 5 pairs or no spread in either side. */
export function spearman(xs, ys) {
  if (xs.length < 5) return null;
  const rx = ranks(xs), ry = ranks(ys), n = xs.length, m = (n + 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - m) * (ry[i] - m);
    sxx += (rx[i] - m) ** 2;
    syy += (ry[i] - m) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Mean and standard error of a list; SE is null below two values. */
function meanSE(values) {
  const n = values.length;
  if (!n) return { mean: null, se: null, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const se = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n) : null;
  return { mean, se, n };
}

/**
 * How each replayed verdict worked out `sessions` later, for stocks (ETFs excluded; SPY is the yardstick) that
 * `include(ticker)` accepts. Dates come from testDates(), so every standard error treats each date as one independent
 * test. Outcomes are total returns from the close after the reading (forwardReturn). `costBps` is one round trip
 * (fees plus spread). `benchmark` is a BENCHMARKS key.
 * Returns { dates, sessions, buckets: { [bucket]: { n, dates, excess: {mean, se}, hitRate, raw, net } } }
 * where excess is the return over the benchmark and net is the raw return less the round trip.
 */
export function scorecard(replay, states, { sessions = 21, costBps = 2, include = () => true, benchmark = "beta" } = {}) {
  const spy = replay.tickers.SPY;
  const spyIndex = new Map(spy.candles.map((k, i) => [k.t, i]));
  const complete = [...new Set(states.map(s => s.t))].sort((a, b) => a - b)
    .filter(t => spyIndex.has(t) && forwardReturn(spy.candles, spyIndex.get(t), sessions) !== null);
  const picked = new Set(testDates(complete, sessions));

  const perDate = new Map();
  for (const s of states) {
    if (s.etf || !picked.has(s.t) || !include(s.ticker)) continue;
    const r = forwardReturn(replay.tickers[s.ticker].candles, s.i, sessions);
    const m = forwardReturn(spy.candles, spyIndex.get(s.t), sessions);
    if (r === null || m === null) continue;
    if (!perDate.has(s.t)) perDate.set(s.t, []);
    perDate.get(s.t).push({ ...s, r, excess: excessReturn(r, m, s.beta, benchmark) });
  }
  for (const obs of perDate.values()) compareWithSector(obs, benchmark, o => replay.tickers[o.ticker].sector);

  const cost = costBps / 10000;
  const buckets = {};
  for (const { key } of BUCKETS) {
    const dateMeans = [], rawMeans = [];
    let n = 0, hits = 0;
    for (const obs of perDate.values()) {
      const inBucket = obs.filter(o => o.bucket === key);
      if (!inBucket.length) continue;
      n += inBucket.length;
      hits += inBucket.filter(o => o.excess > 0).length;
      dateMeans.push(inBucket.reduce((s, o) => s + o.excess, 0) / inBucket.length);
      rawMeans.push(inBucket.reduce((s, o) => s + o.r, 0) / inBucket.length);
    }
    const raw = meanSE(rawMeans);
    buckets[key] = { n, dates: dateMeans.length, excess: meanSE(dateMeans), hitRate: n ? hits / n : null, raw, net: raw.mean === null ? null : raw.mean - cost };
  }
  return { dates: perDate.size, sessions, buckets };
}

/**
 * The live record: verdicts the app actually published (Firestore snapshots, fundamentals included), scored with the
 * replay's daily closes `sessions` later against the benchmark. One reading per stock per market day (the day's last build).
 * @param {Array} snapshots stored snapshot documents ({ day, at, tickers: { [ticker]: { bucket, ... } } })
 * Days are thinned so no two windows overlap (see below), so SE across days treats each as an independent test.
 * `since` (YYYY-MM-DD) keeps only days after it, for scoring a hypothesis registered on that day.
 * Returns { days, eligibleDays, buckets: { [bucket]: { n, excess: {mean, se}, hitRate } } }.
 */
export function liveRecord(replay, snapshots, { sessions = 5, benchmark = "beta", since = "" } = {}) {
  const lastOfDay = new Map();
  for (const s of snapshots) {
    if (s.day <= since) continue;
    if (!lastOfDay.has(s.day) || lastOfDay.get(s.day).at < s.at) lastOfDay.set(s.day, s);
  }
  const indexOf = (ticker, day) => {
    const candles = replay.tickers[ticker]?.candles;
    if (!candles) return null;
    const t = Date.parse(`${day}T00:00:00Z`);
    const i = candles.findIndex(k => k.t === t);
    return i < 0 ? null : i;
  };
  // Newest complete day first, then each earlier day at least `sessions` sessions before the last one kept, so no two
  // windows overlap (overlapping windows share returns and would make the standard errors look smaller than they are).
  const spyCandles = replay.tickers.SPY.candles;
  const spyIndexMap = new Map(spyCandles.map((k, i) => [k.t, i]));
  const days = [...lastOfDay.keys()]
    .map(day => ({ day, si: indexOf("SPY", day) }))
    .filter(d => d.si !== null && forwardReturn(spyCandles, d.si, sessions) !== null)
    .sort((a, b) => b.si - a.si);
  const kept = [];
  for (const d of days) if (!kept.length || kept.at(-1).si - d.si >= sessions) kept.push(d);

  const perDay = new Map();
  for (const { day, si } of kept) {
    const s = lastOfDay.get(day);
    const m = forwardReturn(spyCandles, si, sessions);
    for (const [ticker, reading] of Object.entries(s.tickers ?? {})) {
      if (replay.tickers[ticker]?.etf !== false) continue;
      const i = indexOf(ticker, day);
      const r = i === null ? null : forwardReturn(replay.tickers[ticker].candles, i, sessions);
      if (r === null) continue;
      if (!perDay.has(day)) perDay.set(day, []);
      const beta = benchmark === "spy" ? null : trailingBeta(replay.tickers[ticker].candles, i, spyCandles, spyIndexMap);
      perDay.get(day).push({ ticker, bucket: reading.bucket, excess: excessReturn(r, m, beta, benchmark) });
    }
  }
  for (const obs of perDay.values()) compareWithSector(obs, benchmark, o => replay.tickers[o.ticker].sector);
  const buckets = {};
  for (const { key } of BUCKETS) {
    const dayMeans = [];
    let n = 0, hits = 0;
    for (const obs of perDay.values()) {
      const inBucket = obs.filter(o => o.bucket === key);
      if (!inBucket.length) continue;
      n += inBucket.length;
      hits += inBucket.filter(o => o.excess > 0).length;
      dayMeans.push(inBucket.reduce((s, o) => s + o.excess, 0) / inBucket.length);
    }
    buckets[key] = { n, excess: meanSE(dayMeans), hitRate: n ? hits / n : null };
  }
  return { days: perDay.size, eligibleDays: days.length, sessions, buckets };
}

/**
 * Engine analogs for one stock at bar `origin`: the `count` past states (any stock) nearest to this stock's latest
 * reading at or before `origin`, among those whose next `horizon` sessions had fully happened by then.
 * @param {Map<string, object>} prepsByTicker simulator prepare() output per ticker, so matches can be replayed
 * Returns [{ prep, end, weight, ticker, t, distance }] nearest first, weights summing to 1; [] without a reading.
 */
export function engineMatches(replay, states, prepsByTicker, ticker, origin, { horizon = 30, count = 150 } = {}) {
  const own = replay.tickers[ticker];
  const originT = own.candles[origin].t;
  let current = null;
  for (const s of states) if (s.ticker === ticker && s.i <= origin && (!current || s.i > current.i)) current = s;
  if (!current) return [];

  const scored = [];
  for (const s of states) {
    const candles = replay.tickers[s.ticker].candles;
    if (s.i + horizon >= candles.length || candles[s.i + horizon].t > originT) continue;
    let d = 0;
    for (let k = 0; k < s.features.length; k++) d += (s.features[k] - current.features[k]) ** 2;
    scored.push({ s, distance: Math.sqrt(d) });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => a.distance - b.distance);
  const top = scored.slice(0, Math.min(count, Math.max(1, Math.floor(scored.length / 3))));
  const bandwidth = top[top.length >> 1].distance || 1e-6;
  let total = 0;
  const matches = top.map(({ s, distance }) => {
    const weight = Math.exp(-0.5 * (distance / bandwidth) ** 2);
    total += weight;
    return { prep: prepsByTicker.get(s.ticker), end: s.i, weight, ticker: s.ticker, t: s.t, distance };
  });
  for (const m of matches) m.weight /= total;
  return matches;
}
