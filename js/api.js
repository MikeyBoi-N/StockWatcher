/**
 * Public developer API: static JSON files built from data/market.json with the same engine the page uses.
 *
 * Only StockWatcher's own readings are published: the four scores and their factor points, the verdict, the levels the
 * engine derived, diagnostic labels, peer ranks and bear/bull positions, plus SEC EDGAR fundamentals and 8-K filings
 * (US government data, public domain). Quotes, price history, options chains, analyst figures and headlines come from
 * Yahoo Finance, Nasdaq.com and Cboe, whose terms restrict redistribution, so none of them are copied in, and neither
 * is the factor and diagnostic detail text that quotes them. tests/api.test.mjs holds the line.
 *
 * scripts/build_api.mjs writes:
 *   api/v1/stocks.json            build info, market context and a summary row per tracked stock
 *   api/v1/stocks/{TICKER}.json   one stock's full reading
 * The README's Developer API section documents every field. Within v1 fields may be added; renaming or removing one
 * needs a v2 path.
 */
import { SCORE_KEYS, buildMarketContext, classifyEvaluations, evaluateAsset } from "./engine.js";
import { PEER_METRICS, rankPeers } from "./benchmarks.js";
import { filingActions } from "./developments.js";
import { HORIZONS, horizonReading } from "./grades.js";

export const API_VERSION = 1;
export const API_DOCS_URL = "https://github.com/MikeyBoi-N/StockWatcher#developer-api";
export const API_DISCLAIMER = "Rule-based research readings for education, not investment advice. Thresholds are hand-chosen, not fitted to past returns.";

/** Tickers that are safe as file names: the same pattern firestore.rules enforces on tickerRequests. */
const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, digits) => isNum(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null;

// Everything here is computed from SEC filings alone. trailingPe and historical5yPe sit in the same object but are
// divided by Yahoo prices, so they stay out.
const SEC_FIELDS = [
  "periodEnd", "basis", "reportingCurrency", "revenue", "revenueGrowthYoY", "earningsGrowthYoY", "operatingMargin",
  "operatingMarginChange", "freeCashFlow", "fcfTrend", "netDebtToEbitda", "epsTTM", "sharesOutstanding",
  "buybacksTTM", "dividendsTTM", "latestQuarter", "direction"
];

function secFundamentals(f) {
  if (!f) return null;
  const out = {};
  for (const key of SEC_FIELDS) out[key] = f[key] ?? null;
  if (out.latestQuarter) out.latestQuarter = { ...out.latestQuarter };
  return out;
}

const labels = (list) => list.map(({ name, value, tone }) => ({ name, value, tone }));

/** One stock's full reading: api/v1/stocks/{TICKER}.json. */
function stockDocument(e, spy, peerRanks, meta) {
  const { item, levels, diagnostics } = e;
  const scores = {};
  for (const key of SCORE_KEYS) {
    scores[key] = {
      score: e.scores[key].score,
      factors: e.scores[key].factors.map(f => ({ label: f.label, points: round(f.points, 1), max: f.max, missing: f.missing }))
    };
  }
  const bull = {};
  for (const h of HORIZONS) {
    const reading = horizonReading(item, spy, h.key);
    bull[h.key] = reading ? { position: reading.position, word: reading.word } : null;
  }
  const peers = {};
  for (const m of PEER_METRICS) {
    const r = peerRanks?.get(m.key);
    if (r) peers[m.key] = { label: m.label, rank: r.rank, of: r.of, leader: r.leader };
  }
  return {
    meta,
    ticker: item.ticker,
    name: item.name ?? null,
    exchange: item.exchange ?? null,
    sector: item.sector ?? null,
    industry: item.industry ?? null,
    etf: Boolean(item.etf),
    primary: Boolean(item.isPrimary),
    asOf: item.asOf ?? null,
    verdict: { bucket: e.bucket, label: e.verdict },
    overall: e.overall,
    scores,
    levels: {
      entrySupport: round(levels.entrySupport, 2),
      entrySupportMethod: levels.entryMethod ?? null,
      structuralSupport: round(levels.structural, 2),
      resistance: round(levels.resistance, 2),
      preferredEntryLow: round(levels.zoneLow, 2),
      preferredEntryHigh: round(levels.zoneHigh, 2),
      targetSource: levels.targetSource,
      upside: round(levels.upside, 4),
      downside: round(levels.downside, 4),
      rewardRisk: round(levels.rewardRisk, 2),
      distanceFromPreferredEntry: round(levels.distanceFromIdeal, 4),
      downsideToStructural: round(levels.toStructural, 4)
    },
    entry: { type: diagnostics.entryType, chaseRisk: diagnostics.chase, trigger: diagnostics.trigger, primaryTrend: diagnostics.primaryTrend },
    earningsWithin14Days: Boolean(e.earningsWarning),
    options: { vehicle: e.optionsEval.recommendation, liquid: e.optionsEval.isLiquid ?? null },
    bull,
    peers,
    diagnostics: {
      market: labels(diagnostics.market),
      quality: labels(diagnostics.quality),
      technical: labels(diagnostics.technical),
      entry: labels(diagnostics.entry)
    },
    fundamentals: secFundamentals(item.fundamentals),
    filings: filingActions(item).map(({ date, code, label, short, tone, url }) => ({ date, item: code, label, short, tone, url })),
    dataGaps: e.dataGaps
  };
}

/**
 * Builds every API document for one data build.
 * @param {object} market parsed data/market.json
 * @returns {{index: object, stocks: Map<string, object>}} the stocks.json body, and each stock's document by ticker
 */
export function apiDocuments(market) {
  const primary = new Set(market.universe?.primary ?? []);
  // Tickers become file names, so anything that could escape api/v1/stocks/ is dropped rather than written.
  const records = Object.values(market.stocks ?? {})
    .filter(r => TICKER_PATTERN.test(r.ticker ?? ""))
    .map(r => ({ ...r, isPrimary: primary.has(r.ticker) }));
  const context = buildMarketContext(records, market.sectors);
  const evaluations = records.map(item => evaluateAsset(item, context));
  const { sorted, best } = classifyEvaluations(evaluations);
  const ranks = rankPeers(evaluations);
  const meta = { apiVersion: API_VERSION, generatedAt: market.generatedAt, docs: API_DOCS_URL, disclaimer: API_DISCLAIMER };

  const stocks = new Map();
  for (const e of sorted) stocks.set(e.item.ticker, stockDocument(e, context.spy, ranks.get(e.item.ticker), meta));

  const index = {
    meta,
    market: {
      regime: context.regime,
      description: context.regimeDescription,
      breadth: round(context.breadthNow, 4),
      breadthMonthAgo: round(context.breadthPrior, 4),
      trackedStocks: context.trackedStocks
    },
    best: best?.item.ticker ?? null,
    stocks: sorted.map(e => ({
      ticker: e.item.ticker,
      name: e.item.name ?? null,
      sector: e.item.sector ?? null,
      etf: Boolean(e.item.etf),
      primary: Boolean(e.item.isPrimary),
      verdict: { bucket: e.bucket, label: e.verdict },
      overall: e.overall,
      scores: Object.fromEntries(SCORE_KEYS.map(k => [k, e.scores[k].score])),
      chaseRisk: e.diagnostics.chase,
      href: `stocks/${e.item.ticker}.json`
    })),
    unavailable: Object.keys(market.failures ?? {}).sort()
  };
  return { index, stocks };
}
