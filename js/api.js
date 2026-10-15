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
 *   api/v1/stocks/{TICKER}.json   one stock's full reading, with the Strategy as rules and per-dollar figures
 * The README's Developer API section documents every field. Within v1 fields may be added; renaming or removing one
 * needs a v2 path.
 */
import { SCORE_KEYS, buildMarketContext, classifyEvaluations, evaluateAsset, excludeScreened } from "./engine.js";
import { PEER_METRICS, rankPeers } from "./benchmarks.js";
import { filingActions } from "./developments.js";
import { HORIZONS, horizonReading } from "./grades.js";
import { STRATEGY_FIELDS, buildStrategy } from "./strategy.js";
import { signalReadings } from "./edge.js";

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

/**
 * The Strategy is sized from the reader's own budget, so the API publishes it without one: built at the largest budget
 * (so no option falls back to shares for lack of money) and 1% risk per trade, then every dollar figure is divided by
 * the capital the position uses. A reader sizes it with position = min(budget, budget × risk% ÷ 100 ÷ lossAtStop).
 * Only rules, the engine's own levels and these ratios go out: the order's prices, strikes and expiration, and the exit
 * date (which gives away the earnings date) are quotes or close to them.
 */
const STRATEGY_REFERENCE = {
  budget: STRATEGY_FIELDS.budget.max, riskPct: STRATEGY_FIELDS.riskPct.default,
  horizonDays: STRATEGY_FIELDS.horizonDays.default, maxSpreadPct: STRATEGY_FIELDS.maxSpreadPct.default, instruments: "any"
};
const EXPIRATION_RULE = "the monthly expiration nearest 52 days out (40-70 days)";
const STRATEGY_LEGS = {
  shares: [],
  call: [{ side: "buy", kind: "call", strike: "at the money" }],
  spread: [{ side: "buy", kind: "call", strike: "at the money" }, { side: "sell", kind: "call", strike: "nearest listed strike to the target" }],
  csp: [{ side: "sell", kind: "put", strike: "highest listed strike at or below preferredEntryHigh (and above the stop)" }]
};

function strategyBlock(e, context, now, edge) {
  const s = buildStrategy(e, STRATEGY_REFERENCE, context, now, edge);
  const reference = { riskPct: STRATEGY_REFERENCE.riskPct, holdDays: STRATEGY_REFERENCE.horizonDays, maxOptionSpreadPct: STRATEGY_REFERENCE.maxSpreadPct };
  if (s.status === "pass") {
    return { reference, status: "pass", reasonCode: s.code, vehicle: null, entry: null, stop: null, legs: [], exit: null, perDollar: null, rewardRisk: null, risk: null };
  }
  const act = s.status === "act";
  const perDollar = (v) => round(v / s.cost, 4);
  return {
    reference,
    status: s.status,
    reasonCode: null,
    vehicle: s.vehicle,
    entry: { when: act ? "now" : "buy zone", maxPrice: act ? round(s.limit, 2) : null, limit: act ? null : round(s.entry, 2) },
    stop: round(s.stop, 2),
    legs: STRATEGY_LEGS[s.vehicle].map(l => ({ ...l, expiration: EXPIRATION_RULE })),
    exit: {
      maxHoldDays: STRATEGY_REFERENCE.horizonDays,
      beforeEarnings: true,
      daysBeforeExpiration: s.vehicle === "shares" ? null : 21
    },
    perDollar: {
      lossAtStop: perDollar(s.lossAtStop),
      worstCase: perDollar(s.worstLoss),
      gainAtTarget: perDollar(s.gainAtTarget),
      maxGain: isNum(s.maxGain) ? perDollar(s.maxGain) : null,
      expectedValue: perDollar(s.ev.total)
    },
    rewardRisk: round(s.rewardRisk, 2),
    risk: { score: s.risk.score, label: s.risk.label, factors: s.risk.factors.map(({ label, points, max }) => ({ label, points, max })) }
  };
}

/** One stock's full reading: api/v1/stocks/{TICKER}.json. */
function stockDocument(e, context, peerRanks, meta, edge) {
  const spy = context.spy;
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
    screened: Boolean(item.isScreened),
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
    signal: edge ? { model: edge.label, expectedExcessReturn: round(edge.expected, 4), sessions: edge.sessions, rank: edge.rank, of: edge.of } : null,
    strategy: strategyBlock(e, context, new Date(meta.generatedAt), edge),
    dataGaps: e.dataGaps
  };
}

/**
 * Builds every API document for one data build.
 * @param {object} market parsed data/market.json
 * @param {object} [options] { model }: the paper record's frozenModel() (js/edge.js), for each stock's signal
 * @returns {{index: object, stocks: Map<string, object>}} the stocks.json body, and each stock's document by ticker
 */
export function apiDocuments(market, { model = null } = {}) {
  const primary = new Set(market.universe?.primary ?? []), screened = new Set(market.screened ?? []);
  // Tickers become file names, so anything that could escape api/v1/stocks/ is dropped rather than written.
  const records = Object.values(market.stocks ?? {})
    .filter(r => TICKER_PATTERN.test(r.ticker ?? ""))
    .map(r => ({ ...r, isPrimary: primary.has(r.ticker), isScreened: screened.has(r.ticker) }));
  const context = buildMarketContext(excludeScreened(records, market), market.sectors);
  const evaluations = records.map(item => evaluateAsset(item, context));
  const { sorted, best } = classifyEvaluations(evaluations);
  const ranks = rankPeers(evaluations);
  const meta = { apiVersion: API_VERSION, generatedAt: market.generatedAt, docs: API_DOCS_URL, disclaimer: API_DISCLAIMER };

  const stocks = new Map();
  const signals = signalReadings(excludeScreened(records, market), context, model);
  const edgeFor = (ticker) => signals.has(ticker) ? { ...signals.get(ticker), sessions: model.sessions, label: model.label } : null;
  for (const e of sorted) stocks.set(e.item.ticker, stockDocument(e, context, ranks.get(e.item.ticker), meta, edgeFor(e.item.ticker)));

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
      screened: Boolean(e.item.isScreened),
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

const escapeHtml = (value) => String(value ?? "n/a").replace(/[&<>"']/g, ch => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
));
const percent = (v) => isNum(v) ? `${Math.round(v * 100)}%` : "n/a";

/**
 * A static HTML summary of stocks.json, which scripts/build_api.mjs writes into the published index.html so clients
 * that don't run JavaScript (AI agents' page fetchers, crawlers) see the readings instead of "Loading market data…".
 * Built only from the stocks.json body, so it carries nothing the API doesn't. The page hides it when its script runs.
 * @param {object} index the stocks.json body from apiDocuments
 * @returns {string} a <section> element
 */
export function snapshotHtml(index) {
  const { meta, market } = index;
  const best = index.stocks.find(s => s.ticker === index.best);
  const example = index.stocks[0];
  const rows = index.stocks.map(s => `<tr><td>${escapeHtml(s.ticker)}</td><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.verdict.label)}</td>`
    + `<td>${escapeHtml(s.overall)}</td>${SCORE_KEYS.map(k => `<td>${escapeHtml(s.scores[k])}</td>`).join("")}<td>${escapeHtml(s.chaseRisk)}</td></tr>`);
  return `<section class="snapshot">
      <h2>Readings from the build at ${escapeHtml(meta.generatedAt)}</h2>
      <p>Market regime: <strong>${escapeHtml(market.regime)}</strong>. ${escapeHtml(market.description)}
        Breadth: ${percent(market.breadth)} of ${escapeHtml(market.trackedStocks)} tracked stocks are above their 50-day average (${percent(market.breadthMonthAgo)} a month ago).</p>
      <p>Best idea: ${best ? `<strong>${escapeHtml(best.ticker)}</strong> (${escapeHtml(best.name)})` : "none; no stock is in the buy zone"}.${index.unavailable.length ? ` Data failed this build for ${escapeHtml(index.unavailable.join(", "))}.` : ""}</p>
      <p>The same readings as JSON: <a href="api/v1/stocks.json">api/v1/stocks.json</a>, and one stock's full reading at api/v1/stocks/{TICKER}.json${example ? `, for example <a href="api/v1/${escapeHtml(example.href)}">api/v1/${escapeHtml(example.href)}</a>` : ""}. <a href="${escapeHtml(meta.docs)}">API documentation</a>.</p>
      <div class="table-wrap">
        <table class="bench">
          <thead><tr><th>Ticker</th><th>Name</th><th>Verdict</th><th>Overall</th><th>Quality</th><th>Trend</th><th>Entry</th><th>Trade</th><th>Chase risk</th></tr></thead>
          <tbody>
            ${rows.join("\n            ")}
          </tbody>
        </table>
      </div>
      <p>Scores are 0-100. ${escapeHtml(meta.disclaimer)}</p>
    </section>`;
}
