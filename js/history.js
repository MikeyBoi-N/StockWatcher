/**
 * Recommendation history.
 *
 * Every data build (three a weekday, about four hours apart) is stored as its own snapshot. Nothing is averaged
 * at write time: the Historical view shows each build, or folds a market day's builds into a daily average when it
 * reads them. A snapshot is keyed by its build's own timestamp (snapshotId), so recording the same build twice is
 * refused instead of being counted twice, and a deploy or a re-run can never blend into data already stored.
 *
 * Two Firestore documents per build, sharing that id:
 *   snapshots/{id}       { at, generatedAt, day, regime, breadth, tickers: { [ticker]: reading } }
 *   snapshotInputs/{id}  { at, day, tickers: { [ticker]: { [field]: number } } }
 * One reading:
 *   { n, price, overall, quality, trend, entry, trade, bull: { [horizon]: position }, verdict, bucket, gaps }
 * `at` is the build time in epoch ms and is what every query filters and sorts on. `n` is how many builds a reading
 * averages: 1 for every snapshot a build writes, more only for a day stored before snapshots were kept per build.
 *
 * `snapshotInputs` holds the raw measurements the engine read, not only the scores it produced, because the scoring
 * rules will be retuned and none of this can be backfilled. They sit in their own document because they are several
 * times larger than the readings and only the model-training export needs them, so the table never downloads them.
 *
 * scripts/record_history.mjs writes both from the real engine and the Historical view reads them back. Both sides
 * share this module so a stored snapshot always means what the live table meant.
 */
import { SCORE_KEYS } from "./engine.js";
import { HORIZONS, bullWord, horizonReading } from "./grades.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, digits) => isNum(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null;

/** How many calendar days back the Historical view can load. */
export const HISTORY_DAY_LIMITS = [30, 90, 180];

/** How the Historical view lays out its columns: one per build, or one per market day averaging that day's builds. */
export const HISTORY_RESOLUTIONS = [
  { key: "build", label: "Every build" },
  { key: "daily", label: "Daily average" }
];

/** How many sessions ahead each snapshot's day is measured, to show whether a reading worked out. */
export const FORWARD_WINDOWS = [5, 30];

/**
 * What a cell can show. `horizon` marks the one metric that needs a bear/bull period; `score` marks the ones
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
// Columns are narrow and there are a lot of them, so the verdict shows as its bucket; the full wording
// ("Strong asset, poor entry") is still stored, and the table puts it in the cell's tooltip.
const BUCKET_LABELS = { buy: "Buy zone", strong: "Strong asset", watch: "Watch", avoid: "Avoid" };
const BULL_TONES = { Bullish: "pos", Firm: "pos", Neutral: "", Weak: "warn", Bearish: "neg" };

/**
 * The US market date a build belongs to, so the three weekday builds (11am, 3pm and 7pm New York, often an hour or
 * more later when GitHub runs the schedule late) all land on the same day whatever the server clock is doing.
 */
export function marketDay(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(iso ? new Date(iso) : new Date());
}

/** Saturdays and Sundays are not sessions, even when a push runs a build on one. */
const isWeekend = (day) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/**
 * The document id for a build: its timestamp as 20260918T005447Z. Sorts chronologically, carries no characters that
 * need escaping in a Firestore path, and is the same every time the same build is recorded.
 */
export function snapshotId(generatedAt) {
  return new Date(generatedAt).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * The raw measurements the engine read that build, stored beside the scores it produced. The scores are one model's
 * opinion and the rules behind them will be retuned; these are what actually happened, so a later model can be
 * trained on the features rather than only on this engine's verdicts. A field left out here is lost for good.
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

/** Levels the engine derived for the build, kept for the same reason as the inputs. */
const LEVEL_FIELDS = ["entrySupport", "structural", "target", "rewardRisk", "downside", "upside"];

export const INPUT_KEYS = [...Object.keys(INPUT_FIELDS), ...LEVEL_FIELDS];

/** One build's reading for one evaluated stock, with its raw inputs attached (snapshotDocuments splits them off). */
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

/**
 * The two Firestore documents for one build: the readings the table shows, and the raw inputs only the export needs.
 * @param {{regime, breadth, tickers}} snapshot from snapshotFromEvaluations (readings may carry `inputs`)
 * @param {string} generatedAt the build time from data/market.json
 * @returns {{id: string, snapshot: Object, inputs: Object}}
 */
export function snapshotDocuments(snapshot, generatedAt) {
  const at = Date.parse(generatedAt);
  const day = marketDay(generatedAt);
  const readings = {};
  const inputs = {};
  for (const [ticker, { inputs: fields, ...reading }] of Object.entries(snapshot.tickers ?? {})) {
    readings[ticker] = reading;
    inputs[ticker] = fields ?? {};
  }
  return {
    id: snapshotId(generatedAt),
    snapshot: { at, generatedAt, day, regime: snapshot.regime ?? null, breadth: snapshot.breadth ?? null, tickers: readings },
    inputs: { at, day, tickers: inputs }
  };
}

const MEAN_KEYS = ["price", "overall", ...SCORE_KEYS];

/**
 * Folds one reading into a running mean, each side weighted by how many builds it already averages (`n`). A field
 * missing from either side keeps whatever the other side has rather than averaging against a gap, so a build that
 * lost its options feed cannot drag a score down. The verdict is a rule-based label and cannot be averaged, so the
 * later reading's wins. Used to build daily averages from per-build snapshots.
 */
export function foldSample(existing, sample) {
  if (!existing || !isNum(existing.n)) return { ...sample, n: sample.n ?? 1, bull: { ...sample.bull } };
  const n = existing.n;
  const m = isNum(sample.n) ? sample.n : 1;
  const mean = (a, b, digits) => {
    if (!isNum(b)) return isNum(a) ? a : null;
    if (!isNum(a)) return b;
    return round((a * n + b * m) / (n + m), digits);
  };
  const folded = { ...existing, n: n + m, verdict: sample.verdict, bucket: sample.bucket };
  for (const key of MEAN_KEYS) folded[key] = mean(existing[key], sample[key], key === "price" ? 2 : 1);
  folded.bull = { ...existing.bull };
  for (const h of HORIZONS) {
    const value = mean(existing.bull?.[h.key], sample.bull?.[h.key], 1);
    if (isNum(value)) folded.bull[h.key] = value;
  }
  if (existing.inputs || sample.inputs) {
    folded.inputs = { ...existing.inputs };
    for (const key of new Set([...Object.keys(existing.inputs ?? {}), ...Object.keys(sample.inputs ?? {})])) {
      const value = mean(existing.inputs?.[key], sample.inputs?.[key], 6);
      if (isNum(value)) folded.inputs[key] = value;
    }
  }
  if (isNum(sample.gaps) || isNum(existing.gaps)) folded.gaps = Math.max(existing.gaps ?? 0, sample.gaps ?? 0);
  return folded;
}

/**
 * Folds per-build snapshots into one pseudo-snapshot per market day. Readings average; the regime and breadth are
 * market-wide labels, so a day keeps its last build's. The bear/bull word is re-derived from the averaged position
 * when it is shown, so the label and the number can never disagree.
 */
export function dailyAverages(snapshots) {
  const byDay = new Map();
  for (const s of [...snapshots].sort((a, b) => a.at - b.at)) {
    const day = byDay.get(s.day) ?? { id: s.day, day: s.day, tickers: {} };
    Object.assign(day, { at: s.at, generatedAt: s.generatedAt, regime: s.regime, breadth: s.breadth });
    for (const [ticker, reading] of Object.entries(s.tickers ?? {})) day.tickers[ticker] = foldSample(day.tickers[ticker], reading);
    byDay.set(s.day, day);
  }
  return [...byDay.values()];
}

/* ------------------------------------------------------------------ reading it back */

const metricOf = (key) => HISTORY_METRICS.find(m => m.key === key) ?? HISTORY_METRICS[0];

/**
 * What one cell shows for one stock.
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
 * The number a cell sorts by, so sorting a column always agrees with what that column shows. Higher is better
 * in every metric, including the verdict; null when there is no reading.
 */
export function metricValue(entry, metricKey, horizon) {
  if (!entry) return null;
  const metric = metricOf(metricKey);
  if (metric.key === "price") return entry.price ?? null;
  if (metric.score) return entry[metric.key] ?? null;
  if (metric.key === "verdict") return BUCKET_ORDER[entry.bucket] ?? null;
  return entry.bull?.[horizon] ?? null;
}

const average = (values) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;

/**
 * One ticker's price path through the recorded sessions. Each session's last snapshot stands in for its close (the
 * evening build runs after the market closes), and weekend builds are skipped because they are not sessions.
 * @returns {{sessions: string[], forwardFrom: (day: string, window: number) => number|null, sinceFirst: number|null}}
 */
function priceSeries(chronological, ticker) {
  const closes = new Map();
  const prices = [];
  for (const s of chronological) {
    const price = s.tickers?.[ticker]?.price;
    if (!isNum(price) || price <= 0) continue;
    prices.push(price);
    if (!isWeekend(s.day)) closes.set(s.day, price);
  }
  const sessions = [...closes.keys()];
  const index = new Map(sessions.map((d, i) => [d, i]));
  const forwardFrom = (day, window) => {
    const i = index.get(day);
    const to = i === undefined ? undefined : sessions[i + window];
    return to ? closes.get(to) / closes.get(day) - 1 : null;
  };
  // One snapshot has nothing to compare against, so it reads as no change measured rather than 0%.
  const sinceFirst = prices.length > 1 ? prices[prices.length - 1] / prices[0] - 1 : null;
  return { sessions, forwardFrom, sinceFirst };
}

const tickersIn = (snapshots) => [...new Set(snapshots.flatMap(s => Object.keys(s.tickers ?? {})))].sort();

/**
 * Turns snapshots into the Historical table: one row per ticker, one column per build or per market day.
 * @param {Array} snapshots stored snapshot documents (with their `id`), in any order
 * @param {{resolution?: "build"|"daily"}} options
 * @returns {{columns: Array, rows: Array}} `columns` newest first, each `{id, day, at, generatedAt, regime}`; each row
 *   carries `cells` in that same order plus the outcome summary (`firstSeen`, `sessions`, `sinceFirst`, `forward`)
 */
export function historyRows(snapshots, { resolution = "build" } = {}) {
  const chronological = [...snapshots].sort((a, b) => a.at - b.at);
  const columns = [...(resolution === "daily" ? dailyAverages(chronological) : chronological)].reverse();

  const rows = tickersIn(chronological).map(ticker => {
    const { sessions, forwardFrom, sinceFirst } = priceSeries(chronological, ticker);
    const forward = {};
    for (const w of FORWARD_WINDOWS) forward[w] = average(sessions.map(d => forwardFrom(d, w)).filter(isNum));
    return {
      ticker,
      firstSeen: chronological.find(s => s.tickers?.[ticker])?.day ?? null,
      sessions: sessions.length,
      sinceFirst,
      forward,
      cells: columns.map(c => {
        const reading = c.tickers?.[ticker];
        return reading ? { ...reading, forward: Object.fromEntries(FORWARD_WINDOWS.map(w => [w, forwardFrom(c.day, w)])) } : null;
      })
    };
  });
  return { columns: columns.map(({ tickers, ...column }) => column), rows };
}

/**
 * One record per stock per build, oldest first: the market backdrop, the reading, the raw inputs and what the price
 * did over the sessions that followed. This is the export to train or tune a model on.
 * @param {Array} snapshots stored snapshot documents (with their `id`)
 * @param {Map<string, Object>} inputsById snapshotInputs documents by the same id; a missing one leaves inputs empty
 */
export function historyRecords(snapshots, inputsById = new Map()) {
  const chronological = [...snapshots].sort((a, b) => a.at - b.at);
  const series = new Map(tickersIn(chronological).map(t => [t, priceSeries(chronological, t)]));
  const records = [];
  for (const s of chronological) {
    const inputs = inputsById.get(s.id)?.tickers ?? {};
    for (const [ticker, reading] of Object.entries(s.tickers ?? {})) {
      const { forwardFrom } = series.get(ticker);
      records.push({
        ticker, id: s.id, at: s.at, generatedAt: s.generatedAt, day: s.day, regime: s.regime ?? null, breadth: s.breadth ?? null,
        reading, inputs: inputs[ticker] ?? {},
        forward: Object.fromEntries(FORWARD_WINDOWS.map(w => [w, forwardFrom(s.day, w)]))
      });
    }
  }
  return records;
}
