import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_VERSION, apiDocuments } from "../js/api.js";

// Distinctive values so a leak shows up as an exact string in the serialized output.
const stock = (ticker, overrides = {}) => ({
  ticker, name: `${ticker} Corp`, exchange: "NASDAQ", etf: false, sector: "Technology", industry: "Software", asOf: "2026-10-13T20:00:00+00:00",
  price: 123.47, prevClose: 121.93, high52: 151.29, low52: 77.31, sma20: 119.5, sma50: 117.25, sma200: 104.75, rsi14: 57.83, hv30: 0.2917,
  volume: 48213377, avgVolume20: 39125811,
  majorSupport: 101.13, entrySupport: 113.21, majorResistance: null, return5d: 0.0123, return1m: 0.0341, return3m: 0.0712, return6m: 0.1093, return12m: 0.1871,
  marketCap: 987654321012,
  fundamentals: {
    source: "SEC EDGAR XBRL", periodEnd: "2026-06-30", basis: "ttm", reportingCurrency: "USD", foreignFiler: false,
    revenue: 5e10, revenueGrowthYoY: 0.12, earningsGrowthYoY: 0.18, operatingMargin: 0.25, operatingMarginChange: 0.01,
    freeCashFlow: 9e9, fcfTrend: "growing", netDebtToEbitda: 0.4, epsTTM: 4.2, trailingPe: 29.39, historical5yPe: 26.71,
    sharesOutstanding: 2e9, buybacksTTM: 3e9, dividendsTTM: 1e9, direction: "getting_stronger",
    latestQuarter: { periodEnd: "2026-06-30", currency: "USD", revenue: 1.3e10, revenuePriorYear: 1.1e10, operatingIncome: 3e9, operatingIncomePriorYear: 2.5e9, netIncome: 2e9, netIncomePriorYear: 1.7e9 }
  },
  valuation: { forwardPe: 27.13, trailingPe: 29.39, historical5yPe: 26.71, pegRatio: 1.67, fcfYield: 0.0377 },
  catalysts: { nextEarningsDate: "2026-11-05", daysToEarnings: 23, ntmEps: 4.66, analystCount: 11, revisionsUp: 3, revisionsDown: 1, oneYearTarget: 166.66 },
  options: {
    source: "Cboe delayed quotes", expiration: "2026-12-18", atmCallStrike: 125, atmCallBid: 6.11, atmCallAsk: 6.29, atmCallOpenInterest: 4321,
    atmCallDelta: 0.5432, atmCallTheta: -0.0876, impliedVolatility: 0.3141, ivHvRatio: 1.08, expectedMovePct: 0.0991
  },
  headlines: [{ title: "Acme raises guidance", publisher: "Yahoo", url: "https://finance.yahoo.com/x", tone: "positive" }],
  historicalSeries: [{ date: "2026-10-13", close: 123.47 }],
  filingEvents: [
    { date: "2026-09-02", form: "8-K", url: "https://www.sec.gov/Archives/x.htm", items: [{ code: "5.02", label: "Officer departure or appointment", short: "Leadership change", tone: "neutral" }] },
    { date: "2026-08-01", form: "8-K", url: "https://www.sec.gov/Archives/y.htm", items: [{ code: "2.02", label: "Results of operations", short: "Results", tone: "neutral" }] }
  ],
  ...overrides
});

const market = (extra = {}) => ({
  generatedAt: "2026-10-14T15:05:00+00:00",
  universe: { primary: ["SPY", "AAA"], secondary: ["BBB"] },
  requested: [],
  stocks: {
    SPY: stock("SPY", { etf: true, fundamentals: null, filingEvents: null, return12m: 0.14, return3m: 0.04 }),
    AAA: stock("AAA"),
    BBB: stock("BBB", { rsi14: 49.11, majorResistance: 131.17 })
  },
  failures: { ZZZZ: ["no price data"] },
  ...extra
});

test("stocks.json lists every stock in page order with a link to its own document", () => {
  const { index, stocks } = apiDocuments(market());
  assert.equal(index.meta.apiVersion, API_VERSION);
  assert.equal(index.meta.generatedAt, "2026-10-14T15:05:00+00:00");
  assert.deepEqual(index.stocks.map(s => s.ticker).sort(), ["AAA", "BBB", "SPY"]);
  assert.deepEqual([...stocks.keys()], index.stocks.map(s => s.ticker));
  for (const row of index.stocks) {
    assert.equal(row.href, `stocks/${row.ticker}.json`);
    assert.deepEqual(Object.keys(row.scores), ["quality", "trend", "entry", "trade"]);
    assert.equal(row.overall, stocks.get(row.ticker).overall);
  }
  assert.deepEqual(index.unavailable, ["ZZZZ"]);
  assert.ok(["BULLISH", "NEUTRAL", "CAUTIOUS", "BEARISH"].includes(index.market.regime));
  assert.equal(index.stocks.find(s => s.ticker === "AAA").primary, true);
  assert.equal(index.stocks.find(s => s.ticker === "BBB").primary, false);
});

test("a stock document carries the engine's reading without quoting third-party data", () => {
  const { index, stocks } = apiDocuments(market());
  const raw = market().stocks;
  const forbiddenKeys = ["price", "prevClose", "high52", "low52", "sma20", "sma50", "sma200", "rsi14", "hv30", "volume", "avgVolume20",
    "marketCap", "valuation", "catalysts", "headlines", "historicalSeries", "trailingPe", "historical5yPe", "detail", "parts", "reason"];

  const keysIn = (value, found = new Set()) => {
    if (Array.isArray(value)) value.forEach(v => keysIn(v, found));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysIn(v, found); }
    return found;
  };
  for (const doc of [index, ...stocks.values()]) {
    const keys = keysIn(doc);
    for (const key of forbiddenKeys) assert.ok(!keys.has(key), `published key "${key}"`);
  }

  const text = JSON.stringify([index, ...stocks.values()]);
  for (const r of Object.values(raw)) {
    const quoted = [r.price, r.prevClose, r.high52, r.low52, r.rsi14, r.hv30, r.volume, r.marketCap, r.valuation.forwardPe, r.valuation.pegRatio,
      r.valuation.fcfYield, r.catalysts.oneYearTarget, r.catalysts.ntmEps, r.options.atmCallBid, r.options.atmCallAsk, r.options.impliedVolatility,
      r.options.ivHvRatio, r.options.atmCallOpenInterest, r.options.atmCallDelta, r.fundamentals?.trailingPe];
    for (const value of quoted.filter(v => v != null)) assert.ok(!text.includes(String(value)), `published ${value} from ${r.ticker}`);
  }
  for (const word of ["Acme raises guidance", "finance.yahoo.com", "Cboe", "2026-11-05"]) assert.ok(!text.includes(word), `published "${word}"`);
});

test("a stock document has scores with factor points, levels, labels, SEC fundamentals and 8-K filings", () => {
  const doc = apiDocuments(market()).stocks.get("AAA");
  assert.equal(doc.ticker, "AAA");
  assert.equal(doc.name, "AAA Corp");
  for (const key of ["quality", "trend", "entry", "trade"]) {
    assert.ok(Number.isFinite(doc.scores[key].score));
    for (const f of doc.scores[key].factors) assert.deepEqual(Object.keys(f), ["label", "points", "max", "missing"]);
  }
  assert.ok(["buy", "strong", "watch", "avoid"].includes(doc.verdict.bucket));
  assert.equal(doc.levels.entrySupport, 113.21);
  assert.equal(doc.levels.structuralSupport, 101.13);
  assert.equal(doc.levels.targetSource, "analyst target");
  assert.ok(["Low", "Moderate", "High"].includes(doc.entry.chaseRisk));
  assert.deepEqual(Object.keys(doc.bull), ["24h", "5d", "30d", "6m", "12m"]);
  assert.ok(doc.bull["30d"].position >= 0 && doc.bull["30d"].position <= 100);
  for (const section of Object.values(doc.diagnostics)) {
    for (const d of section) assert.deepEqual(Object.keys(d), ["name", "value", "tone"]);
  }
  assert.equal(doc.fundamentals.revenueGrowthYoY, 0.12);
  assert.equal(doc.fundamentals.latestQuarter.netIncome, 2e9);
  // 2.02 is the routine results release, which the quarter summary already covers.
  assert.deepEqual(doc.filings, [{ date: "2026-09-02", item: "5.02", label: "Officer departure or appointment", short: "Leadership change", tone: "neutral", url: "https://www.sec.gov/Archives/x.htm" }]);
});

test("ETFs publish without fundamentals", () => {
  const doc = apiDocuments(market()).stocks.get("SPY");
  assert.equal(doc.etf, true);
  assert.equal(doc.fundamentals, null);
  assert.deepEqual(doc.filings, []);
});

test("a ticker that could escape the stocks folder is never published", () => {
  const m = market();
  m.stocks["../x"] = stock("../x");
  m.stocks["a/b"] = stock("a/b");
  const { index, stocks } = apiDocuments(m);
  assert.deepEqual([...stocks.keys()].sort(), ["AAA", "BBB", "SPY"]);
  assert.equal(index.stocks.length, 3);
});

test("the committed data build produces a document for every stock it holds", () => {
  const committed = JSON.parse(readFileSync(new URL("../data/market.json", import.meta.url), "utf8"));
  const { index, stocks } = apiDocuments(committed);
  assert.equal(stocks.size, Object.keys(committed.stocks).length);
  assert.equal(index.stocks.length, stocks.size);
  // Peer ranks need at least five stocks with data, which the committed build has.
  const peers = stocks.get("AAPL").peers;
  assert.equal(peers.trend.of, stocks.size);
  assert.deepEqual(Object.keys(peers.quality), ["label", "rank", "of", "leader"]);
});
