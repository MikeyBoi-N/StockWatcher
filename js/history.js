/**
 * Daily recommendation history.
 *
 * Every data build records what the engine said about each stock that day. Builds run several times a weekday,
 * so the samples inside one session date are folded into a running mean (`n` counts them) and stored as a single
 * daily entry, keyed by the US market date. Numbers average; the bear/bull word is re-derived from the averaged
 * position so the label and the number can never disagree. A verdict is a rule-based label that cannot be
 * averaged, so the day keeps the last one it saw.
 *
 * One day document (Firestore `history/{YYYY-MM-DD}`):
 *   { day, regime, breadth, generatedAt, tickers: { [ticker]: entry } }
 * One entry:
 *   { n, price, overall, quality, trend, entry, trade, bull: { [horizon]: position }, verdict, bucket,
 *     inputs: { [field]: number }, gaps }
 *
 * `inputs` holds the raw measurements the engine read, not just the scores it produced, because the scoring rules
 * will be retuned and none of this can be backfilled: a day that was not recorded never existed.
 *
 * scripts/record_history.mjs writes it from the real engine; the Historical view reads it back. Both sides share
 * this module so a stored snapshot always means what the live table meant.
 */
import { SCORE_KEYS } from "./engine.js";
import { HORIZONS, bullWord, horizonReading } from "./grades.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, digits) => isNum(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null;

/** How many days of columns the Historical view offers. */
export const HISTORY_DAY_LIMITS = [30, 90, 180];

/** How far ahead each stored day's price is measured, to show whether a reading worked out. */
export const FORWARD_WINDOWS = [5, 30];

/**
 * What a day cell can show. `horizon` marks the one metric that needs a bear/bull period; `score` marks the ones
 * coloured by the shared 0-100 score tones.
 */
export const HISTORY_METRICS = [
  { key: "bull", label: "Bull / bear", horizon: true },
  { key: "verdict", label: "Verdict" },
  { key: "overall", label: "Overall", score: true },
  { key: "quality", label: "Quality", score: true },
  { key: "trend", label: "Trend", score: true },
  { key: "entry", label: "Entry", score: true },
  { key: "trade", label: "Trade", score: true },
  { key: "price", label: "Price" }
];

const BUCKET_TONES = { buy: "pos", strong: "warn", watch: "muted", avoid: "neg" };
// Day columns are narrow and there are a lot of them, so the verdict shows as its bucket; the full wording
// ("Strong asset, poor entry") is still stored, and the table puts it in the cell's tooltip.
const BUCKET_LABELS = { buy: "Buy zone", strong: "Strong asset", watch: "Watch", avoid: "Avoid" };
const BULL_TONES = { Bullish: "pos", Firm: "pos", Neutral: "", Weak: "warn", Bearish: "neg" };

/**
 * The US market date a build belongs to, so the three weekday builds (11am, 3pm and 7pm New York) all land on
 * the same day whatever the server clock or daylight saving is doing.
 */
export function marketDay(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(iso ? new Date(iso) : new Date());
}

/**
 * The raw measurements the engine read that day, stored beside the scores it produced. The scores are one model's
 * opinion and the rules behind them will be retuned; these are what actually happened, so a later model can be
 * trained on the features rather than only on this engine's verdicts. There is no way to backfill them, so a field
 * left out here is lost for good - which is why this list is wider than anything the table shows.
 */
const INPUT_FIELDS = {
  prevClose: (i) => i.prevClose,
  high52: (i) => i.high52,
  low52: (i) => i.low52,
  sma20: (i) => i.sma20,
  sma50: (i) => i.sma50,
  sma200: (i) => i.sma200,
  rsi14: (i) => i.rsi14,
  hv30: (i) => i.hv30,
  volume: (i) => i.volume,
  avgVolume20: (i) => i.avgVolume20,
  return5d: (i) => i.return5d,
  return1m: (i) => i.return1m,
  return3m: (i) => i.return3m,
  return6m: (i) => i.return6m,
  return12m: (i) => i.return12m,
  marketCap: (i) => i.marketCap,
  revenueGrowthYoY: (i) => i.fundamentals?.revenueGrowthYoY,
  operatingMargin: (i) => i.fundamentals?.operatingMargin,
  netDebtToEbitda: (i) => i.fundamentals?.netDebtToEbitda,
  freeCashFlow: (i) => i.fundamentals?.freeCashFlow,
  forwardPe: (i) => i.valuation?.forwardPe,
  trailingPe: (i) => i.valuation?.trailingPe,
  pegRatio: (i) => i.valuation?.pegRatio,
  fcfYield: (i) => i.valuation?.fcfYield,
  daysToEarnings: (i) => i.catalysts?.daysToEarnings,
  revisionsUp: (i) => i.catalysts?.revisionsUp,
  revisionsDown: (i) => i.catalysts?.revisionsDown,
  oneYearTarget: (i) => i.catalysts?.oneYearTarget,
  impliedVolatility: (i) => i.options?.impliedVolatility,
  ivHvRatio: (i) => i.options?.ivHvRatio,
  atmCallDelta: (i) => i.options?.atmCallDelta,
  atmCallOpenInterest: (i) => i.options?.atmCallOpenInterest
};

/** Levels the engine derived for the day, kept for the same reason as the inputs. */
const LEVEL_FIELDS = ["entrySupport", "structural", "target", "rewardRisk", "downside", "upside"];

export const INPUT_KEYS = [...Object.keys(INPUT_FIELDS), ...LEVEL_FIELDS];

/** One build's reading for one evaluated stock. Scores are whole numbers here; averaging adds the decimals. */
export function sampleFromEvaluation(e, spy) {
  const bull = {};
  for (const h of HORIZONS) {
    const reading = horizonReading(e.item, spy, h.key);
    if (reading) bull[h.key] = reading.position;
  }
  const sample = { n: 1, price: round(e.item.price, 2), overall: e.overall, bull, verdict: e.verdict, bucket: e.bucket };
  for (const key of SCORE_KEYS) sample[key] = e.scores[key].score;

  const inputs = {};
  for (const [key, read] of Object.entries(INPUT_FIELDS)) {
    const value = read(e.item);
    if (isNum(value)) inputs[key] = round(value, 6);
  }
  for (const key of LEVEL_FIELDS) {
    if (isNum(e.levels[key])) inputs[key] = round(e.levels[key], 6);
  }
  sample.inputs = inputs;
  // Data the engine had to guess at. Worth knowing which rows were scored on complete information.
  if (e.dataGaps.length) sample.gaps = e.dataGaps.length;
  return sample;
}

/** One build's reading for every evaluated stock, plus the market backdrop it was read against. */
export function snapshotFromEvaluations(evaluations, context) {
  const tickers = {};
  for (const e of evaluations) tickers[e.item.ticker] = sampleFromEvaluation(e, context.spy);
  return { regime: context.regime, breadth: round(context.breadthNow, 4), tickers };
}

const MEAN_KEYS = ["price", "overall", ...SCORE_KEYS];

/**
 * Folds one build's sample into the day's running mean. A field missing from either side keeps whatever the other
 * side has rather than averaging against a gap, so a build that lost its options feed cannot drag a score down.
 */
export function foldSample(existing, sample) {
  if (!existing || !isNum(existing.n)) return { ...sample, bull: { ...sample.bull } };
  const n = existing.n;
  const mean = (a, b, digits) => {
    if (!isNum(b)) return isNum(a) ? a : null;
    if (!isNum(a)) return b;
    return round((a * n + b) / (n + 1), digits);
  };
  const folded = { ...existing, n: n + 1, verdict: sample.verdict, bucket: sample.bucket };
  for (const key of MEAN_KEYS) folded[key] = mean(existing[key], sample[key], key === "price" ? 2 : 1);
  folded.bull = { ...existing.bull };
  for (const h of HORIZONS) {
    const value = mean(existing.bull?.[h.key], sample.bull?.[h.key], 1);
    if (isNum(value)) folded.bull[h.key] = value;
  }
  folded.inputs = { ...existing.inputs };
  for (const key of new Set([...Object.keys(existing.inputs ?? {}), ...Object.keys(sample.inputs ?? {})])) {
    const value = mean(existing.inputs?.[key], sample.inputs?.[key], 6);
    if (isNum(value)) folded.inputs[key] = value;
  }
  if (isNum(sample.gaps) || isNum(existing.gaps)) folded.gaps = Math.max(existing.gaps ?? 0, sample.gaps ?? 0);
  return folded;
}

/** Folds a whole build into the stored day document, creating it on the first build of the day. */
export function foldDay(existingDay, snapshot, generatedAt, day = marketDay(generatedAt)) {
  const tickers = { ...(existingDay?.tickers ?? {}) };
  for (const [ticker, sample] of Object.entries(snapshot.tickers)) {
    tickers[ticker] = foldSample(tickers[ticker], sample);
  }
  // The regime is a label and breadth is one market-wide reading, so the day keeps the last build's rather than
  // averaging them the way the per-stock numbers are averaged.
  return { day, regime: snapshot.regime, breadth: snapshot.breadth ?? null, generatedAt, tickers };
}

/* ------------------------------------------------------------------ reading it back */

const metricOf = (key) => HISTORY_METRICS.find(m => m.key === key) ?? HISTORY_METRICS[0];

/**
 * What one day cell shows for one stock.
 * @param {(score: number|null) => string} scoreTone the shared 0-100 tone scale, injected so this module does not
 *   need the page's formatting rules
 * @returns {{text: string, sub: string|null, tone: string}} `sub` is the second line (the Overall score beside a
 *   word or a verdict); `tone` is "", "pos", "warn", "neg" or "muted"
 */
export function metricCell(entry, metricKey, horizon, scoreTone) {
  const metric = metricOf(metricKey);
  if (!entry) return { text: "—", sub: null, tone: "muted" };
  if (metric.key === "price") {
    return { text: isNum(entry.price) ? `$${entry.price.toFixed(2)}` : "—", sub: null, tone: isNum(entry.price) ? "" : "muted" };
  }
  if (metric.score) {
    const score = entry[metric.key];
    return { text: isNum(score) ? String(Math.round(score)) : "—", sub: null, tone: scoreTone(score) };
  }
  const overall = isNum(entry.overall) ? String(Math.round(entry.overall)) : null;
  if (metric.key === "verdict") {
    return { text: BUCKET_LABELS[entry.bucket] ?? entry.verdict ?? "—", sub: overall, tone: BUCKET_TONES[entry.bucket] ?? "muted" };
  }
  const position = entry.bull?.[horizon];
  if (!isNum(position)) return { text: "—", sub: overall, tone: "muted" };
  const word = bullWord(position);
  return { text: word, sub: overall, tone: BULL_TONES[word] };
}

const BUCKET_ORDER = { avoid: 1, watch: 2, strong: 3, buy: 4 };

/**
 * The number a day cell sorts by, so sorting a column always agrees with what that column shows. Higher is better
 * in every metric, including the verdict; null when the day has no reading.
 */
export function metricValue(entry, metricKey, horizon) {
  if (!entry) return null;
  const metric = metricOf(metricKey);
  if (metric.key === "price") return entry.price ?? null;
  if (metric.score) return entry[metric.key] ?? null;
  if (metric.key === "verdict") return BUCKET_ORDER[entry.bucket] ?? null;
  return entry.bull?.[horizon] ?? null;
}

/**
 * Return over the `window` sessions after a stored day, from that day's price to the price `window` days later in
 * the record. Recorded days are build days, so consecutive entries are consecutive trading sessions.
 */
const forwardReturn = (entries, index, window) => {
  const from = entries[index]?.price;
  const to = entries[index + window]?.price;
  return isNum(from) && from > 0 && isNum(to) ? to / from - 1 : null;
};

const average = (values) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;

/**
 * Turns stored days into one row per ticker.
 * @param {Array<{day: string, tickers: Object}>} days stored day documents, in any order
 * @param {{tickers?: string[]}} options restrict to these tickers (a watchlist); omit for every ticker seen
 * @returns {{days: string[], rows: Array}} `days` newest first (the column order); each row carries `cells` in that
 *   same order plus the outcome summary (`firstSeen`, `sinceFirst`, `forward` keyed by window)
 */
export function historyRows(days, { tickers } = {}) {
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const wanted = tickers ? new Set(tickers) : null;
  const names = new Set();
  for (const d of ordered) {
    for (const ticker of Object.keys(d.tickers ?? {})) {
      if (!wanted || wanted.has(ticker)) names.add(ticker);
    }
  }

  const rows = [...names].sort().map(ticker => {
    // Sessions this ticker was actually recorded in; a ticker added later has no entry on the earlier days.
    const series = ordered.map(d => ({ day: d.day, entry: d.tickers?.[ticker] ?? null })).filter(x => x.entry);
    const entries = series.map(x => x.entry);
    const prices = entries.map(e => e.price).filter(v => isNum(v) && v > 0);
    const forward = {};
    for (const window of FORWARD_WINDOWS) {
      forward[window] = average(entries.map((_, i) => forwardReturn(entries, i, window)).filter(isNum));
    }
    const byDay = new Map(series.map((x, i) => [x.day, {
      ...x.entry,
      forward: Object.fromEntries(FORWARD_WINDOWS.map(w => [w, forwardReturn(entries, i, w)]))
    }]));
    return {
      ticker,
      firstSeen: series[0]?.day ?? null,
      sessions: series.length,
      sinceFirst: prices.length > 1 ? prices[prices.length - 1] / prices[0] - 1 : null,
      forward,
      byDay
    };
  });

  const columns = ordered.map(d => d.day).reverse();
  for (const row of rows) row.cells = columns.map(day => row.byDay.get(day) ?? null);
  return { days: columns, rows };
}
