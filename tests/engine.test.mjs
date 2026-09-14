import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  RULES, applyScenario, classifyEvaluations, determineMarketRegime, evaluateAsset, evaluateOptions
} from "../js/engine.js";

const base = () => ({
  ticker: "TEST", name: "Test Corp", etf: false, sector: "Technology",
  price: 100, high52: 110, low52: 70, sma20: 99, sma50: 97, sma200: 90, rsi14: 52,
  majorSupport: 96.5, secondarySupport: 90, majorResistance: 108,
  fundamentals: { revenueGrowthYoY: 0.22, operatingMargin: 0.32, netDebtToEbitda: 0.2, freeCashFlow: 1e9, direction: "getting_stronger" },
  valuation: { forwardPe: 22, trailingPe: 25, historical5yPe: 28, pegRatio: 1.0, fcfYield: 0.05 },
  catalysts: { daysToEarnings: 40, nextEarningsDate: "2026-10-24", revisionsUp: 3, revisionsDown: 0, oneYearTarget: 125 },
  options: { atmCallStrike: 100, atmCallBid: 4.9, atmCallAsk: 5.0, atmCallOpenInterest: 5000, atmCallDelta: 0.52, atmCallTheta: -0.05, impliedVolatility: 0.3, ivHvRatio: 1.0, daysToExpiration: 52 }
});

const allNumbersFinite = (value) => {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.values(value).every(allNumbersFinite);
  return true;
};

test("scores depend on data, never on the ticker symbol", () => {
  const a = evaluateAsset({ ...base(), ticker: "NVDA" }, "BULLISH");
  const b = evaluateAsset({ ...base(), ticker: "ZZZZ" }, "BULLISH");
  assert.equal(a.totalScore, b.totalScore);
});

test("a strong setup near support scores as the best opportunity", () => {
  const { best, actionable } = classifyEvaluations([evaluateAsset(base(), "BULLISH")]);
  assert.ok(best, "expected a best opportunity");
  assert.ok(best.totalScore >= RULES.bestScore);
  assert.equal(actionable.length, 1);
});

test("ETF with no fundamentals, valuation, catalysts or options scores without NaN", () => {
  const etf = { ...base(), ticker: "SPY", etf: true, sector: null, fundamentals: null,
    valuation: { forwardPe: null, trailingPe: null, historical5yPe: null, pegRatio: null, fcfYield: null },
    catalysts: { daysToEarnings: null, revisionsUp: null, revisionsDown: null, oneYearTarget: null }, options: null };
  const e = evaluateAsset(etf, "NEUTRAL");
  assert.ok(Number.isInteger(e.totalScore) && e.totalScore >= 0 && e.totalScore <= 100);
  assert.equal(e.fund.available, false);
  assert.equal(e.fund.assessment, "N/A (ETF)");
  assert.ok(allNumbersFinite({ tech: e.tech, fund: e.fund, val: e.val, cat: e.cat, score: e.totalScore }));
  assert.deepEqual(e.dataGaps, ["options chain"]);
});

test("new listing without a 200-day SMA reports the gap instead of scoring it", () => {
  const e = evaluateAsset({ ...base(), sma200: null }, "BULLISH");
  assert.ok(e.dataGaps.some(g => g.includes("200-day SMA")));
  assert.ok(Number.isFinite(e.totalScore));
});

test("extended stocks always land in avoid, even with a high score", () => {
  const extended = { ...base(), price: 125, majorSupport: 110 };
  const e = evaluateAsset(extended, "BULLISH");
  assert.equal(e.tech.isExtended, true);
  const { avoid, actionable, notReady } = classifyEvaluations([e]);
  assert.equal(avoid.length, 1);
  assert.equal(actionable.length + notReady.length, 0);
});

test("buckets are mutually exclusive and cover every evaluation", () => {
  const records = [
    base(),
    { ...base(), ticker: "EXT", price: 130 },
    { ...base(), ticker: "WEAK", fundamentals: { ...base().fundamentals, revenueGrowthYoY: -0.2, direction: "getting_weaker" }, valuation: { pegRatio: 4, forwardPe: 60, historical5yPe: 20, fcfYield: 0.01 } },
    { ...base(), ticker: "EARN", catalysts: { ...base().catalysts, daysToEarnings: 5 } }
  ];
  const result = classifyEvaluations(records.map(r => evaluateAsset(r, "NEUTRAL")));
  const tickers = [...result.actionable, ...result.notReady, ...result.avoid].map(e => e.item.ticker).sort();
  assert.deepEqual(tickers, records.map(r => r.ticker).sort());
  assert.ok(!result.actionable.some(e => e.item.ticker === "EARN"), "earnings inside 14 days is never actionable");
});

test("a high score away from support waits in not-ready instead of being actionable", () => {
  const e = evaluateAsset({ ...base(), majorSupport: 85 }, "BULLISH");
  assert.ok(e.totalScore >= RULES.actionableScore, `score ${e.totalScore}`);
  assert.equal(e.tech.nearSupport, false);
  const { notReady, best } = classifyEvaluations([e]);
  assert.equal(notReady.length, 1);
  assert.equal(best, null);
});

test("earnings inside 14 days forces a shares-only vehicle", () => {
  const e = evaluateAsset({ ...base(), catalysts: { ...base().catalysts, daysToEarnings: 7 } }, "BULLISH");
  const vehicle = evaluateOptions(e.item, 80, true);
  assert.equal(vehicle.recommendation, "SHARES ONLY (OR WAIT)");
});

test("options vehicle follows IV vs realized volatility and liquidity", () => {
  const item = base();
  assert.equal(evaluateOptions({ ...item, options: { ...item.options, ivHvRatio: 1.5 } }, 80, false).recommendation, "CASH-SECURED PUT OR SHARES");
  assert.equal(evaluateOptions({ ...item, options: { ...item.options, ivHvRatio: 0.8 } }, 80, false).recommendation, "LONG CALL OR CALL DEBIT SPREAD");
  assert.equal(evaluateOptions(item, 80, false).recommendation, "CALL DEBIT SPREAD");
  assert.equal(evaluateOptions({ ...item, options: { ...item.options, atmCallOpenInterest: 10 } }, 80, false).recommendation, "SHARES");
  assert.equal(evaluateOptions(item, 60, false).recommendation, "WAIT");
});

test("market regime covers bullish, neutral, cautious and bearish", () => {
  const idx = (ticker, price, sma50, sma200) => ({ ticker, price, sma50, sma200 });
  assert.equal(determineMarketRegime([idx("SPY", 110, 100, 90), idx("QQQ", 110, 100, 90)]).regime, "BULLISH");
  assert.equal(determineMarketRegime([idx("SPY", 95, 100, 90), idx("QQQ", 110, 100, 90)]).regime, "NEUTRAL");
  assert.equal(determineMarketRegime([idx("SPY", 85, 100, 90), idx("QQQ", 110, 100, 90)]).regime, "CAUTIOUS");
  assert.equal(determineMarketRegime([idx("SPY", 85, 100, 90), idx("QQQ", 80, 100, 90)]).regime, "BEARISH");
  assert.equal(determineMarketRegime([]).regime, "NEUTRAL");
});

test("a bearish regime lowers scores relative to bullish", () => {
  assert.ok(evaluateAsset(base(), "BEARISH").totalScore < evaluateAsset(base(), "BULLISH").totalScore);
});

test("stress scenarios return copies and leave the real data untouched", () => {
  const records = [base()];
  const shocked = applyScenario(records, "pullback");
  assert.equal(records[0].price, 100);
  assert.equal(shocked[0].price, 92);
  assert.equal(applyScenario(records, "overbought")[0].price, 108);
  assert.equal(applyScenario(records, "high_iv")[0].options.ivHvRatio, 1.6);
});

test("bear case names concrete risks and the invalidation level", () => {
  const e = evaluateAsset({ ...base(), price: 125 }, "CAUTIOUS");
  assert.match(e.bearCase.bearCase, /mean reversion/);
  assert.match(e.bearCase.bearCase, /cautious broad market/);
  assert.match(e.bearCase.invalidationLevel, /\$96\.50/);
});

const marketFile = new URL("../data/market.json", import.meta.url);
test("engine scores every stock in the real market snapshot", { skip: !existsSync(marketFile) }, () => {
  const market = JSON.parse(readFileSync(marketFile, "utf8"));
  const records = Object.values(market.stocks);
  const { regime } = determineMarketRegime(records);
  const evaluations = records.map(r => evaluateAsset(r, regime));
  for (const e of evaluations) {
    assert.ok(Number.isInteger(e.totalScore) && e.totalScore >= 0 && e.totalScore <= 100, `${e.item.ticker} score ${e.totalScore}`);
    assert.ok(allNumbersFinite({ tech: e.tech.score, fund: e.fund.score, val: e.val.score, cat: e.cat.score }), e.item.ticker);
    assert.ok(e.item.majorSupport < e.item.price, `${e.item.ticker} support must be below price`);
  }
  const { actionable, notReady, avoid } = classifyEvaluations(evaluations);
  assert.equal(actionable.length + notReady.length + avoid.length, records.length);
});
