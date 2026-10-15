import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLE_PRESETS, buildPortfolio, normalizePortfolioPrefs, portfolioStats, portfolioText, riskWeights, styleFor } from "../js/portfolio.js";

const NOW = new Date(2026, 8, 14, 12);

/** A minimal evaluation: what buildPortfolio reads from evaluateAsset(). */
const ev = (ticker, { bucket = "strong", price = 100, vol = 0.3, beta = 1.2, sector = "Technology", etf = false, gap = 0.1, options = null, earnings = null } = {}) => ({
  bucket, verdict: { buy: "Buy zone", strong: "Strong asset, poor entry", watch: "Watch", avoid: "Avoid, broken trend" }[bucket],
  overall: 70, earningsWarning: false,
  levels: { zoneHigh: price / (1 + gap), distanceFromIdeal: gap, target: price * 1.15, entrySupport: price * 0.9 / (1 + gap) },
  item: { ticker, name: `${ticker} Inc`, etf, sector: etf ? null : sector, price, hv30: vol, volForecast: { vol21: vol }, beta, options, catalysts: { nextEarningsDate: earnings } }
});
const spy = () => ev("SPY", { etf: true, bucket: "strong", price: 700, vol: 0.15, beta: 1 });
const book = () => [
  spy(),
  ev("AAA", { bucket: "buy", sector: "Technology", vol: 0.25 }),
  ev("BBB", { sector: "Technology", vol: 0.5, gap: 0.02 }),
  ev("CCC", { sector: "Health Care", vol: 0.2 }),
  ev("DDD", { sector: "Energy", vol: 0.35 }),
  ev("EEE", { sector: "Financials", vol: 0.3 }),
  ev("WWW", { bucket: "watch" }),
  ev("XXX", { bucket: "avoid" })
];

test("settings default sensibly and clamp", () => {
  const p = normalizePortfolioPrefs({ account: -5, style: "yolo", fractional: "false", options: false, excluded: ["nvda", "NVDA", "bad ticker!", " amd "] });
  assert.equal(p.account, 1);
  assert.equal(p.stocksShare, 0.4, "Balanced by default");
  assert.deepEqual(p.excluded, ["NVDA", "AMD"], "uppercase, unique, well-formed");
  assert.equal(normalizePortfolioPrefs({ style: "active" }).stocksShare, 0.7, "an old saved preset still works");
  assert.equal(normalizePortfolioPrefs({ stocksShare: 0.33 }).stocksShare, 0.35, "snapped to the slider's 5% steps");
  assert.equal(normalizePortfolioPrefs({ stocksShare: 5 }).stocksShare, 0.9);
  assert.equal(p.fractional, false);
  assert.equal(p.options, false);
  assert.equal(normalizePortfolioPrefs({}).fractional, true);
});

test("risk weights favour calm stocks, respect the per-stock cap, and hold each sector to its cap", () => {
  const w = riskWeights([
    { ticker: "A", sector: "Tech", vol: 0.2 }, { ticker: "B", sector: "Tech", vol: 0.4 }, { ticker: "C", sector: "Health", vol: 0.3 }
  ], 0.5, 0.2, 0.25);
  assert.ok(w.get("A") > w.get("B"), "the calmer stock gets more");
  for (const v of w.values()) assert.ok(v <= 0.2 + 1e-12);
  assert.ok(w.get("A") + w.get("B") <= 0.25 + 1e-12, "tech held to its sector cap");
});

test("the slider's presets keep their numbers, and the caps grow smoothly between them", () => {
  assert.deepEqual([0.2, 0.4, 0.7].map(x => [styleFor(x).maxNames, +styleFor(x).maxWeight.toFixed(4), +styleFor(x).sectorCap.toFixed(4)]),
    [[5, 0.05, 0.1], [8, 0.08, 0.16], [12, 0.12, 0.24]]);
  let last = styleFor(0.05);
  for (let x = 0.1; x <= 0.9 + 1e-9; x += 0.05) {
    const s = styleFor(x);
    assert.ok(s.maxWeight >= last.maxWeight && s.maxNames >= last.maxNames, `not monotone at ${x}`);
    last = s;
  }
  assert.equal(styleFor(0).maxNames, 0);
  const allIndex = buildPortfolio(book(), { account: 10000, stocksShare: 0 }, { now: NOW });
  assert.deepEqual(allIndex.holdings.map(h => h.ticker), ["SPY"]);
});

test("excluded stocks are never picked, and the next eligible stock takes the slot", () => {
  const before = buildPortfolio(book(), { account: 100000, stocksShare: 0.4 }, { now: NOW }).holdings.map(h => h.ticker);
  assert.ok(before.includes("AAA"));
  const after = buildPortfolio(book(), { account: 100000, stocksShare: 0.4, excluded: ["AAA", "spy"] }, { now: NOW }).holdings.map(h => h.ticker);
  assert.ok(!after.includes("AAA"));
  assert.ok(after.includes("SPY"), "the index core isn't a stock pick, so excluding it does nothing");
  const plan = buildPortfolio(book(), { account: 100000, stocksShare: 0.7, excluded: ["AAA", "BBB", "CCC", "DDD", "EEE"] }, { now: NOW });
  assert.deepEqual(plan.holdings.map(h => h.ticker), ["SPY"]);
  assert.ok(plan.notes.some(n => /remaining/.test(n)));
});

test("every style keeps the core, caps each stock and sector, and leaves out Watch and Avoid", () => {
  for (const preset of STYLE_PRESETS) {
    const style = styleFor(preset.stocksShare);
    const plan = buildPortfolio(book(), { account: 100000, stocksShare: preset.stocksShare }, { now: NOW });
    const core = plan.holdings.find(h => h.role === "core");
    assert.equal(core.ticker, "SPY");
    assert.ok(core.weight >= style.core - 0.01, `${style.key} core ${core.weight}`);
    for (const h of plan.holdings.filter(x => x.role === "stock")) assert.ok(h.dollars / 100000 <= style.maxWeight + 1e-9, `${h.ticker} over the cap`);
    for (const s of plan.sectors.filter(x => x.sector !== "Index")) assert.ok(s.weight <= style.sectorCap + 1e-6, `${s.sector} ${s.weight}`);
    assert.ok(!plan.holdings.some(h => ["WWW", "XXX"].includes(h.ticker)));
    assert.ok(plan.invested + plan.cash <= 100000 + 1e-6);
    assert.ok(plan.holdings.filter(h => h.role === "stock").length <= style.maxNames);
  }
});

test("each holding gets the method its situation calls for", () => {
  const plan = buildPortfolio(book(), { account: 100000, style: "active" }, { now: NOW });
  const method = (t) => plan.holdings.find(h => h.ticker === t).method.key;
  assert.equal(method("SPY"), "lump", "the core goes in at once");
  assert.equal(method("AAA"), "lump", "a buy-zone stock goes in at once");
  assert.equal(method("BBB"), "limit", "a strong stock 2% above its zone gets a limit");
  assert.equal(method("CCC"), "dca", "a strong stock 10% above its zone gets a DCA schedule");
  const dca = plan.holdings.find(h => h.ticker === "CCC").method;
  assert.equal(dca.tranches.length, 4, "weekly over a 30-day horizon");
  assert.ok(dca.tranches.every(t => t.shares > 0));
});

test("options methods appear only when options are expensive and the account covers 100 shares", () => {
  const rich = { atmCallAsk: 5, atmCallBid: 4.95, atmCallOpenInterest: 5000, impliedVolatility: 0.45, put25Iv: 0.47, call25Iv: 0.42, daysToExpiration: 45, expiration: "2026-10-30" };
  const cheapSpy = { ...spy(), item: { ...spy().item, price: 50, options: { ...rich, impliedVolatility: 0.3 }, volForecast: { vol21: 0.15, volToExpiry: 0.15 } } };
  const csp = ev("PUT", { price: 50, vol: 0.3, gap: 0.1, options: rich });
  csp.item.volForecast.volToExpiry = 0.3;
  const big = buildPortfolio([cheapSpy, csp], { account: 1_000_000, style: "active" }, { now: NOW });
  assert.equal(big.holdings.find(h => h.ticker === "PUT").method.key, "csp");
  assert.equal(big.holdings.find(h => h.ticker === "SPY").overlay?.key, "cc", "IV 2x the forecast on 100+ shares adds a covered call");

  const small = buildPortfolio([cheapSpy, csp], { account: 3000, style: "active" }, { now: NOW });
  assert.notEqual(small.holdings.find(h => h.ticker === "PUT").method.key, "csp", "can't cover 100 shares");
  const off = buildPortfolio([cheapSpy, csp], { account: 1_000_000, style: "active", options: false }, { now: NOW });
  assert.ok(off.holdings.every(h => h.method.key !== "csp" && !h.overlay));
});

test("whole shares only: what can't buy a share goes to the core, and the plan says why", () => {
  const plan = buildPortfolio(book(), { account: 300, style: "active", fractional: false }, { now: NOW });
  assert.ok(plan.holdings.every(h => Number.isInteger(h.shares)));
  assert.ok(plan.notes.some(n => /fractional/.test(n)));
  assert.ok(plan.notes.some(n => /SPY share/.test(n)), "a $700 core share can't be bought with $300");
  const fractional = buildPortfolio(book(), { account: 300, style: "active" }, { now: NOW });
  assert.ok(fractional.holdings.filter(h => h.role === "stock").length >= 4, "fractions let $300 spread across stocks");
});

test("all in the index has the index's risk; stocks with their own risk diversify it", () => {
  const stats = portfolioStats([{ weight: 1, beta: 1, vol: 0.15, cost: 1000 }], { volForecast: { vol21: 0.15 } }, { horizonDays: 30, account: 1000 }, null);
  assert.ok(Math.abs(stats.vol - 0.15) < 1e-12);
  assert.equal(stats.beta, 1);
  assert.ok(Math.abs(stats.diversification - 1) < 1e-12);
  const plan = buildPortfolio(book(), { account: 100000, style: "active" }, { now: NOW });
  assert.ok(plan.stats.diversification > 1, "spreading across stocks lowers risk below the weighted average");
  const text = portfolioText(plan, { generatedAt: "2026-09-14", url: "https://example.test/" });
  assert.ok(!/undefined|NaN/.test(text), text);
});

test("the screened picks can be left out of the plan", () => {
  const all = buildPortfolio(book(), { account: 100000, stocksShare: 0.4 }, { now: NOW, screened: ["AAA"] }).holdings.map(h => h.ticker);
  const tracked = buildPortfolio(book(), { account: 100000, stocksShare: 0.4, universe: "tracked" }, { now: NOW, screened: ["AAA"] }).holdings.map(h => h.ticker);
  assert.ok(all.includes("AAA"));
  assert.ok(!tracked.includes("AAA"));
  assert.ok(tracked.length > 1);
});
