import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  RULES, SCORE_KEYS, VERDICT_LABELS, applyScenario, buildMarketContext, classifyEvaluations, computeLevels,
  determineMarketRegime, evaluateAsset, evaluateOptions, valuationLabel
} from "../js/engine.js";

const spy = () => ({ ticker: "SPY", etf: true, price: 700, sma20: 695, sma50: 690, sma200: 650, return3m: 0.03, return12m: 0.12, hv30: 0.12, prevClose: 698 });
const qqq = () => ({ ticker: "QQQ", etf: true, price: 600, sma50: 590, sma200: 550 });

/** A high-quality company in an uptrend, sitting just above entry support with room to resistance. */
const base = () => ({
  ticker: "TEST", name: "Test Corp", etf: false, sector: "Technology",
  price: 100, prevClose: 99.5, high52: 112, low52: 70, sma20: 99, sma50: 98, sma200: 90, sma50Prior: 95, close21Prior: 97,
  rsi14: 52, hv30: 0.30, majorSupport: 92, secondarySupport: 85, majorResistance: 112,
  entrySupport: 98.5, entrySupportMethod: "50-day SMA", rangeHigh60: 106, rangeLow60: 94,
  return5d: 0.01, return1m: 0.02, return3m: 0.09, return6m: 0.15, return12m: 0.28,
  fundamentals: { revenueGrowthYoY: 0.22, earningsGrowthYoY: 0.30, operatingMargin: 0.32, operatingMarginChange: 0.02, netDebtToEbitda: 0.2, freeCashFlow: 1e9, fcfTrend: "growing", direction: "getting_stronger" },
  valuation: { forwardPe: 22, trailingPe: 25, historical5yPe: 28, pegRatio: 1.0, fcfYield: 0.05 },
  catalysts: { daysToEarnings: 40, nextEarningsDate: "2026-10-24", revisionsUp: 3, revisionsDown: 0, oneYearTarget: 125 },
  options: { atmCallStrike: 100, atmCallBid: 4.9, atmCallAsk: 5.0, atmCallOpenInterest: 5000, atmCallDelta: 0.52, atmCallTheta: -0.05, impliedVolatility: 0.3, ivHvRatio: 1.0, daysToExpiration: 52 }
});

const context = (records = [], regimeRecords = [spy(), qqq()]) => buildMarketContext([...regimeRecords, ...records], { Technology: { etf: "XLK", price: 300, return3m: 0.06 } });
const evaluate = (item, ctx = context([item])) => evaluateAsset(item, ctx);

const allNumbersFinite = (value) => {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.values(value).every(allNumbersFinite);
  return true;
};

test("scores depend on data, never on the ticker symbol", () => {
  const a = evaluate({ ...base(), ticker: "NVDA" });
  const b = evaluate({ ...base(), ticker: "ZZZZ" });
  assert.deepEqual(SCORE_KEYS.map(k => a.scores[k].score), SCORE_KEYS.map(k => b.scores[k].score));
});

test("headlines and 8-K events never change any score", () => {
  const quiet = evaluate({ ...base(), headlines: [], filingEvents: [] });
  const noisy = evaluate({
    ...base(),
    headlines: Array.from({ length: 6 }, (_, i) => ({ title: `Downgrade ${i}`, tone: "negative" })),
    filingEvents: [{ date: "2026-09-01", items: [{ code: "2.05", tone: "negative" }] }]
  });
  assert.equal(noisy.overall, quiet.overall);
  assert.deepEqual(SCORE_KEYS.map(k => noisy.scores[k].score), SCORE_KEYS.map(k => quiet.scores[k].score));
  assert.deepEqual(noisy.warnings, quiet.warnings);
});

test("every score is the sum of its named factors", () => {
  const e = evaluate(base());
  for (const key of SCORE_KEYS) {
    const { score, factors } = e.scores[key];
    const points = factors.reduce((s, f) => s + f.points, 0);
    const max = factors.reduce((s, f) => s + f.max, 0);
    assert.equal(score, Math.round(points / max * 100), key);
    assert.ok(factors.every(f => f.label && f.detail && f.points <= f.max), key);
  }
  const w = RULES.weights;
  assert.equal(e.overall, Math.round(e.scores.quality.score * w.quality + e.scores.trend.score * w.trend + e.scores.entry.score * w.entry + e.scores.trade.score * w.trade));
});

test("a strong company near entry support with room to run is in the buy zone", () => {
  const e = evaluate(base());
  assert.equal(e.bucket, "buy", JSON.stringify(SCORE_KEYS.map(k => e.scores[k].score)));
  assert.equal(e.verdict, VERDICT_LABELS.buy);
  const { best } = classifyEvaluations([e]);
  assert.equal(best, e);
});

test("a great business far above its entry reads 'strong asset, poor entry' rather than a contradictory score", () => {
  // NVDA/MSFT-style: excellent fundamentals, clean uptrend, but price well above entry support.
  const stretched = { ...base(), price: 118, sma20: 112, rsi14: 71, majorResistance: 121, rangeHigh60: 119 };
  const e = evaluate(stretched);
  assert.ok(e.scores.quality.score >= 80 && e.scores.trend.score >= 60, "high quality and trend");
  assert.ok(e.scores.entry.score < RULES.buyZone.entry, `entry ${e.scores.entry.score}`);
  assert.equal(e.bucket, "strong");
  assert.equal(e.verdict, VERDICT_LABELS.strongEntry);
  assert.notEqual(e.diagnostics.chase, "Low");
});

test("entry support and structural support are separate levels", () => {
  // SNDK-style: structural support far below; the trade is judged against the nearby 50-day.
  const item = { ...base(), price: 1531, sma50: 1513.59, sma200: 1040, majorSupport: 998.19, entrySupport: 1513.59, majorResistance: 1828, hv30: 0.89 };
  const levels = computeLevels(item);
  assert.equal(levels.entrySupport, 1513.59);
  assert.equal(levels.structural, 998.19);
  assert.ok(levels.downside < 0.02 && levels.toStructural > 0.3);
  const e = evaluate(item);
  assert.match(e.bearCase.invalidationLevel, /entry support \$1513\.59/);
  assert.match(e.bearCase.invalidationLevel, /structural support \$998\.19/);
});

test("older snapshots without entry support fall back to structural support", () => {
  const { entrySupport, entryMethod } = computeLevels({ ...base(), entrySupport: undefined });
  assert.equal(entrySupport, 92);
  assert.equal(entryMethod, "structural");
});

test("a broken trend or a weak business is avoided, and the verdict says which", () => {
  const downtrend = { ...base(), price: 80, sma20: 84, sma50: 88, sma200: 95, rsi14: 33, return3m: -0.2, return12m: -0.3, entrySupport: 76, majorSupport: 70 };
  const broken = evaluate(downtrend, context([downtrend], [{ ...spy() }, qqq()]));
  assert.equal(broken.bucket, "avoid");
  assert.equal(broken.verdict, VERDICT_LABELS.avoidTrend);

  const weak = evaluate({ ...base(), fundamentals: { revenueGrowthYoY: -0.1, earningsGrowthYoY: -0.4, operatingMargin: -0.05, operatingMarginChange: -0.04, netDebtToEbitda: 4, freeCashFlow: -1e8, direction: "getting_weaker" },
    catalysts: { ...base().catalysts, revisionsUp: 0, revisionsDown: 5 } });
  assert.equal(weak.verdict, VERDICT_LABELS.avoidQuality);
});

test("earnings inside 14 days blocks the buy zone and forces a shares-only vehicle", () => {
  const e = evaluate({ ...base(), catalysts: { ...base().catalysts, daysToEarnings: 5 } });
  assert.notEqual(e.bucket, "buy");
  assert.equal(e.optionsEval.recommendation, "SHARES ONLY (OR WAIT)");
  assert.ok(e.warnings.some(w => /Earnings in 5 days/.test(w)));
});

test("buckets are mutually exclusive and cover every evaluation", () => {
  const records = [base(), { ...base(), ticker: "EXT", price: 125, rsi14: 78 }, { ...base(), ticker: "EARN", catalysts: { ...base().catalysts, daysToEarnings: 5 } }];
  const ctx = context(records);
  const result = classifyEvaluations(records.map(r => evaluateAsset(r, ctx)));
  const tickers = [...result.buy, ...result.strong, ...result.watch, ...result.avoid].map(e => e.item.ticker).sort();
  assert.deepEqual(tickers, records.map(r => r.ticker).sort());
});

test("ETFs have no Quality score and Overall reweights the other three", () => {
  const etf = { ...base(), ticker: "XLK", etf: true, sector: null, fundamentals: null,
    valuation: { forwardPe: null, trailingPe: null, historical5yPe: null, pegRatio: null, fcfYield: null },
    catalysts: { daysToEarnings: null, revisionsUp: null, revisionsDown: null, oneYearTarget: null } };
  const e = evaluate(etf);
  assert.equal(e.scores.quality.score, null);
  assert.ok(Number.isInteger(e.overall));
  const w = RULES.weights;
  const expected = Math.round((e.scores.trend.score * w.trend + e.scores.entry.score * w.entry + e.scores.trade.score * w.trade) / (w.trend + w.entry + w.trade));
  assert.equal(e.overall, expected);
  assert.ok(allNumbersFinite({ t: e.scores.trend.score, e: e.scores.entry.score, tr: e.scores.trade.score }));
});

test("diagnostics cover market context, asset quality, technical state and entry", () => {
  const d = evaluate(base()).diagnostics;
  const names = (section) => d[section].map(x => x.name);
  assert.deepEqual(names("market"), ["Market regime", "Sector regime", "Relative strength", "Market breadth", "Volatility regime"]);
  assert.deepEqual(names("quality"), ["Fundamental quality", "Earnings trend", "Revenue growth", "Margin quality", "Valuation", "Valuation vs growth", "Analyst revision trend"]);
  assert.deepEqual(names("technical"), ["Primary trend", "Short-term trend", "Momentum", "RSI state", "Trend location", "Support distance", "Resistance distance", "Breakout status", "Pullback status"]);
  assert.deepEqual(names("entry"), ["Entry quality", "Entry type", "Risk/reward", "Upside to resistance", "Downside to support", "Distance from ideal entry", "Chase risk", "Invalidation level", "Trigger", "Preferred entry"]);
  const value = (section, name) => d[section].find(x => x.name === name).value;
  assert.equal(value("market", "Sector regime"), "Leading");         // XLK +6% vs SPY +3%
  assert.equal(value("technical", "Primary trend"), "Bullish");
  assert.equal(value("quality", "Valuation"), "Cheap");              // 22x vs a 28x 5-year average
  assert.match(value("entry", "Risk/reward"), /^\d+\.\d : 1$/);
  assert.match(value("technical", "Support distance"), /^−1\.5%$/);
});

test("valuation labels", () => {
  const v = (valuation) => valuationLabel({ valuation });
  assert.equal(v({ forwardPe: 70 }), "Extreme");
  assert.equal(v({ forwardPe: 45 }), "Expensive");
  assert.equal(v({ forwardPe: 30, historical5yPe: 20 }), "Expensive");
  assert.equal(v({ forwardPe: 8 }), "Cheap");
  assert.equal(v({ forwardPe: 20, historical5yPe: 21 }), "Fair");
  assert.equal(v({ forwardPe: -5 }), "Unprofitable");
  assert.equal(v({}), null);
});

test("options vehicle follows readiness, IV vs realized volatility and liquidity", () => {
  const item = base();
  assert.equal(evaluateOptions({ ...item, options: { ...item.options, ivHvRatio: 1.5 } }, true, false).recommendation, "CASH-SECURED PUT OR SHARES");
  assert.equal(evaluateOptions({ ...item, options: { ...item.options, ivHvRatio: 0.8 } }, true, false).recommendation, "LONG CALL OR CALL DEBIT SPREAD");
  assert.equal(evaluateOptions(item, true, false).recommendation, "CALL DEBIT SPREAD");
  assert.equal(evaluateOptions({ ...item, options: { ...item.options, atmCallOpenInterest: 10 } }, true, false).recommendation, "SHARES");
  assert.equal(evaluateOptions(item, false, false).recommendation, "WAIT");
});

test("market regime covers bullish, neutral, cautious and bearish", () => {
  const idx = (ticker, price, sma50, sma200) => ({ ticker, price, sma50, sma200 });
  assert.equal(determineMarketRegime([idx("SPY", 110, 100, 90), idx("QQQ", 110, 100, 90)]).regime, "BULLISH");
  assert.equal(determineMarketRegime([idx("SPY", 95, 100, 90), idx("QQQ", 110, 100, 90)]).regime, "NEUTRAL");
  assert.equal(determineMarketRegime([idx("SPY", 85, 100, 90), idx("QQQ", 110, 100, 90)]).regime, "CAUTIOUS");
  assert.equal(determineMarketRegime([idx("SPY", 85, 100, 90), idx("QQQ", 80, 100, 90)]).regime, "BEARISH");
  assert.equal(determineMarketRegime([]).regime, "NEUTRAL");
});

test("a bearish regime lowers Trend but leaves Quality alone", () => {
  const item = base();
  const bull = evaluate(item);
  const bearCtx = context([item], [{ ...spy(), price: 600 }, { ...qqq(), price: 500 }]);
  const bear = evaluateAsset(item, bearCtx);
  assert.ok(bear.scores.trend.score < bull.scores.trend.score);
  assert.equal(bear.scores.quality.score, bull.scores.quality.score);
});

test("stress scenarios return copies and leave the real data untouched", () => {
  const records = [base()];
  const shocked = applyScenario(records, "pullback");
  assert.equal(records[0].price, 100);
  assert.equal(shocked[0].price, 92);
  assert.equal(applyScenario(records, "overbought")[0].price, 108);
  assert.equal(applyScenario(records, "high_iv")[0].options.ivHvRatio, 1.6);
  // A shock below entry support trades against the next level down instead of a stop above price.
  const levels = computeLevels(shocked[0]);
  assert.ok(levels.entrySupport < shocked[0].price);
});

const marketFile = new URL("../data/market.json", import.meta.url);
test("engine scores every stock in the real market snapshot", { skip: !existsSync(marketFile) }, () => {
  const market = JSON.parse(readFileSync(marketFile, "utf8"));
  const records = Object.values(market.stocks);
  const ctx = buildMarketContext(records, market.sectors);
  const evaluations = records.map(r => evaluateAsset(r, ctx));
  for (const e of evaluations) {
    assert.ok(Number.isInteger(e.overall) && e.overall >= 0 && e.overall <= 100, `${e.item.ticker} overall ${e.overall}`);
    for (const key of SCORE_KEYS) {
      const score = e.scores[key].score;
      assert.ok(score === null ? key === "quality" : Number.isInteger(score) && score >= 0 && score <= 100, `${e.item.ticker} ${key} ${score}`);
    }
    assert.ok(e.levels.entrySupport < e.item.price, `${e.item.ticker} entry support must be below price`);
    assert.ok(allNumbersFinite(e.levels), e.item.ticker);
  }
  const { buy, strong, watch, avoid } = classifyEvaluations(evaluations);
  assert.equal(buy.length + strong.length + watch.length + avoid.length, records.length);
});
