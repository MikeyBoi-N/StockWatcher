import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMarketContext, evaluateAsset } from "../js/engine.js";
import { STRATEGY_FIELDS, blackScholes, buildStrategy, normalizeStrategyPrefs, orderLine, strategyText, touchProbability } from "../js/strategy.js";

const spy = () => ({ ticker: "SPY", etf: true, price: 700, sma20: 695, sma50: 690, sma200: 650, return3m: 0.03, return12m: 0.12, hv30: 0.12, prevClose: 698 });
const qqq = () => ({ ticker: "QQQ", etf: true, price: 600, sma50: 590, sma200: 550 });

/** The engine tests' buy-zone stock, with an options chain that expires 53 days after NOW. */
const base = () => ({
  ticker: "TEST", name: "Test Corp", etf: false, sector: "Technology", asOf: "2026-09-14T20:00:00Z",
  price: 100, prevClose: 99.5, high52: 112, low52: 70, sma20: 99, sma50: 98, sma200: 90, sma50Prior: 95, close21Prior: 97,
  rsi14: 52, hv30: 0.30, majorSupport: 92, secondarySupport: 85, majorResistance: 112,
  entrySupport: 98.5, entrySupportMethod: "50-day SMA", rangeHigh60: 106, rangeLow60: 94,
  return5d: 0.01, return1m: 0.02, return3m: 0.09, return6m: 0.15, return12m: 0.28,
  fundamentals: { revenueGrowthYoY: 0.22, earningsGrowthYoY: 0.30, operatingMargin: 0.32, operatingMarginChange: 0.02, netDebtToEbitda: 0.2, freeCashFlow: 1e9, fcfTrend: "growing", direction: "getting_stronger" },
  valuation: { forwardPe: 22, trailingPe: 25, historical5yPe: 28, pegRatio: 1.0, fcfYield: 0.05 },
  catalysts: { daysToEarnings: 40, nextEarningsDate: "2026-10-24", revisionsUp: 3, revisionsDown: 0, oneYearTarget: 125 },
  options: { expiration: "2026-11-06", atmCallStrike: 100, atmCallBid: 4.9, atmCallAsk: 5.0, atmCallOpenInterest: 5000, atmCallDelta: 0.52, atmCallTheta: -0.05, impliedVolatility: 0.3, ivHvRatio: 1.0, daysToExpiration: 53 }
});
const NOW = new Date(2026, 8, 14, 12);

const context = (item) => buildMarketContext([spy(), qqq(), item], { Technology: { etf: "XLK", price: 300, return3m: 0.06 } });
const plan = (item, prefs = {}) => {
  const ctx = context(item);
  const e = evaluateAsset(item, ctx);
  return { e, s: buildStrategy(e, prefs, ctx, NOW) };
};
const withOptions = (changes) => ({ ...base(), options: { ...base().options, ...changes } });
const allNumbersFinite = (value) => {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.values(value).every(allNumbersFinite);
  return true;
};

test("limits fill from defaults and clamp to their range", () => {
  const p = normalizeStrategyPrefs({ budget: "abc", riskPct: 50, horizonDays: 2.6, maxSpreadPct: -1, instruments: "futures" });
  assert.equal(p.budget, STRATEGY_FIELDS.budget.default);
  assert.equal(p.riskPct, STRATEGY_FIELDS.riskPct.max);
  assert.equal(p.horizonDays, STRATEGY_FIELDS.horizonDays.min);
  assert.equal(p.maxSpreadPct, STRATEGY_FIELDS.maxSpreadPct.min);
  assert.equal(p.instruments, "any");
  assert.deepEqual(normalizeStrategyPrefs(null), normalizeStrategyPrefs({}));
});

test("a buy-zone stock gets an order sized so the stop loses no more than the risk budget", () => {
  const { e, s } = plan(base(), { budget: 10000, riskPct: 1, instruments: "shares", fractional: false });
  assert.equal(e.bucket, "buy");
  assert.equal(s.status, "act");
  assert.equal(s.vehicle, "shares");
  assert.ok(Number.isInteger(s.qty) && s.qty > 0);
  assert.ok(s.lossAtStop <= 100 + 1e-9, `loss at stop ${s.lossAtStop}`);
  assert.ok(s.cost <= 10000);
  assert.ok(s.worstLoss > s.lossAtStop, "a gap through the stop loses more than the stop");
  assert.ok(s.limit >= s.entry, "the most to pay is at or above the current price in the buy zone");
  assert.ok(allNumbersFinite(s));
});

test("the exit comes before earnings when they fall inside the holding period", () => {
  const item = { ...base(), catalysts: { ...base().catalysts, nextEarningsDate: "2026-10-05", daysToEarnings: 21 } };
  const { s } = plan(item, { horizonDays: 30, instruments: "shares" });
  assert.equal(s.closeBy, "2026-10-02", "the Friday before a Monday release");
  assert.match(s.closeByReason, /before earnings/);
});

test("without earnings in the way, the exit is the holding period moved to a weekday", () => {
  const { s } = plan(base(), { horizonDays: 34, instruments: "shares" });
  assert.equal(s.closeBy, "2026-10-16", "Oct 18 is a Sunday");
});

test("the vehicle follows implied vs realized volatility when options are allowed", () => {
  const big = { budget: 100000, riskPct: 2 };
  const call = plan(withOptions({ ivHvRatio: 0.8 }), big).s;
  assert.equal(call.vehicle, "call");
  assert.equal(call.legs[0].modeled, false, "the at-the-money call is a real quote");
  assert.equal(call.worstLoss, call.cost, "a long call can lose its whole premium");
  assert.ok(call.lossAtStop <= 2000 + 1e-9);

  const spread = plan(withOptions({ ivHvRatio: 1.1 }), big).s;
  assert.equal(spread.vehicle, "spread");
  assert.equal(spread.legs.length, 2);
  assert.ok(spread.legs[1].modeled && spread.legs[1].strike > spread.legs[0].strike);
  assert.ok(spread.maxGain > spread.gainAtTarget - 1e-9);

  const put = plan(withOptions({ ivHvRatio: 1.5 }), big).s;
  assert.equal(put.vehicle, "csp");
  assert.ok(put.legs[0].strike > put.stop, "the put is struck above the stop");
  assert.equal(put.cost, put.qty * put.legs[0].strike * 100, "cash set aside covers assignment");
  assert.ok(put.cost <= 100000);

  for (const s of [call, spread, put]) {
    assert.ok(s.worstLoss >= s.lossAtStop - 1e-9, `${s.vehicle}: worst case ${s.worstLoss} below loss at stop ${s.lossAtStop}`);
    assert.ok(s.closeBy <= "2026-10-16", "options close three weeks before the Nov 6 expiration");
    assert.ok(allNumbersFinite(s));
  }
});

test("options wider than the user's spread limit fall back to shares", () => {
  const { s } = plan(withOptions({ ivHvRatio: 0.8, atmCallBid: 4.5 }), { budget: 100000, maxSpreadPct: 5 });
  assert.equal(s.vehicle, "shares");
  assert.ok(s.notes.some(n => n.startsWith("Options skipped")));
});

test("an option too big for the limits falls back to shares and says why", () => {
  const { s } = plan(withOptions({ ivHvRatio: 0.8 }), { budget: 400, riskPct: 1, horizonDays: 60 });
  assert.equal(s.vehicle, "shares");
  assert.ok(s.notes.some(n => /over your/.test(n)));
  assert.equal(s.closeBy, "2026-10-23", "shares exit before earnings, not three weeks before the option's expiry");
});

test("a strong asset that isn't a buy yet gets a planned order at the preferred entry, in shares", () => {
  const item = { ...base(), price: 106, rsi14: 71 };
  const { e, s } = plan(item, { budget: 100000, horizonDays: 60 });
  assert.notEqual(e.bucket, "buy");
  assert.notEqual(e.bucket, "avoid");
  assert.equal(s.status, "plan");
  assert.equal(s.vehicle, "shares");
  assert.equal(s.entry, e.levels.zoneHigh);
  assert.equal(s.closeBy, null);
  const event = s.risk.factors.find(f => f.label === "Event risk");
  assert.match(event.detail, /fall inside the holding period/, "earnings 40 days out sit inside a 60-day hold");
  assert.ok(!/-\d+ days/.test(event.detail));
});

test("avoid verdicts, and whole-share budgets too small for one share, get no trade", () => {
  const broken = { ...base(), price: 80, sma50: 95, sma200: 100, return3m: -0.2, return12m: -0.3, rsi14: 30 };
  const { e, s } = plan(broken);
  assert.equal(e.bucket, "avoid");
  assert.equal(s.status, "pass");
  assert.equal(s.risk, null);
  assert.equal(plan(base(), { budget: 100, riskPct: 0.1, instruments: "shares", fractional: false }).s.status, "pass");
});

test("the risk score is 0-100, the sum of its factors, and rises with leverage", () => {
  const calm = plan(base(), { instruments: "shares" }).s;
  assert.ok(calm.risk.score >= 0 && calm.risk.score <= 100);
  assert.equal(calm.risk.score, calm.risk.factors.reduce((t, f) => t + f.points, 0));
  assert.equal(calm.risk.factors.reduce((t, f) => t + f.max, 0), 100);
  const call = plan(withOptions({ ivHvRatio: 0.8 }), { budget: 100000, riskPct: 2 }).s;
  assert.ok(call.risk.score > calm.risk.score);
});

test("Black-Scholes satisfies put-call parity and the touch odds grow with time", () => {
  const call = blackScholes("call", 100, 105, 0.25, 0.3);
  const put = blackScholes("put", 100, 105, 0.25, 0.3);
  assert.ok(Math.abs(call - put - (100 - 105 * Math.exp(-0.04 * 0.25))) < 1e-6);
  assert.ok(touchProbability(100, 95, 0.3, 21) < touchProbability(100, 95, 0.3, 63));
  assert.equal(touchProbability(95, 100, 0.3, 21), null);
});

test("the copied text carries the order, the figures and every risk factor, with nothing unfilled", () => {
  const cases = [
    plan(base(), { instruments: "shares" }),
    plan(withOptions({ ivHvRatio: 0.8 }), { budget: 100000, riskPct: 2 }),
    plan(withOptions({ ivHvRatio: 1.1 }), { budget: 100000, riskPct: 2 }),
    plan(withOptions({ ivHvRatio: 1.5 }), { budget: 100000, riskPct: 2 }),
    plan({ ...base(), price: 106, rsi14: 71 }),
    plan({ ...base(), price: 80, sma50: 95, sma200: 100, return3m: -0.2, return12m: -0.3, rsi14: 30 })
  ];
  assert.deepEqual(cases.map(c => c.s.status === "pass" ? "pass" : c.s.vehicle), ["shares", "call", "spread", "csp", "shares", "pass"]);
  for (const { e, s } of cases) {
    const text = strategyText(s, e, context(e.item), { generatedAt: "2026-09-14T15:00:00Z", url: "https://example.test/" });
    assert.ok(!/undefined|NaN|\[object/.test(text), text);
    assert.ok(text.includes(`Order: ${orderLine(s, "TEST")}`));
    assert.ok(text.includes("Limits: $"));
    assert.ok(text.includes("Source: https://example.test/"));
    if (s.status === "pass") continue;
    for (const f of s.risk.factors) assert.ok(text.includes(`- ${f.label} ${f.points}/${f.max}: ${f.detail}`));
    for (const l of s.legs) assert.ok(text.includes(l.modeled ? "modeled with Black-Scholes" : "delayed quote"));
  }
  assert.match(orderLine(cases[2].s, "TEST"), /^Buy \d+ TEST Nov 6, 2026 \$100\/\$\d+ call spreads?$/);
});

test("expected value comes only from signal, volatility and costs: a bracket alone is worth nothing", () => {
  const ctx = context(base());
  const e = evaluateAsset(base(), ctx);
  const plain = buildStrategy(e, { instruments: "shares" }, ctx, NOW);
  assert.equal(plain.ev.signal, null, "no model, no signal part");
  assert.ok(plain.ev.costs > 0);
  assert.equal(plain.ev.total, -plain.ev.costs);
  const lv = e.levels;
  assert.ok(Math.abs(plain.targetFirst - Math.log(plain.entry / lv.entrySupport) / Math.log(lv.target / lv.entrySupport)) < 1e-12);

  const up = buildStrategy(e, { instruments: "shares" }, ctx, NOW, { expected: 0.01, sessions: 21 });
  assert.ok(up.ev.signal > 0 && up.ev.total > plain.ev.total);
  assert.ok(Math.abs(up.ev.drift - 0.01 * (up.holdDays * 252 / 365) / 21) < 1e-12, "the month's expected return scaled to the hold");
});

test("options are worth more when the forecast expects more movement than the price implies", () => {
  const forecast = (vol) => ({ ...withOptions({ ivHvRatio: 0.8 }), volForecast: { vol21: vol, diffusive21: vol, volToExpiry: vol, earningsInWindow: false } });
  const value = (vol, vehicle) => {
    const { s } = plan(forecast(vol), { budget: 100000, riskPct: 2 });
    return s.alternatives.find(a => a.vehicle === vehicle).ev;
  };
  assert.ok(value(0.45, "call").volatility > 0, "IV 30% vs 45% expected: the call is cheap");
  assert.ok(value(0.20, "call").volatility < 0, "IV 30% vs 20% expected: the call is dear");
  assert.ok(value(0.20, "csp").volatility > 0, "and selling the put is paid for it");
  const { s } = plan(forecast(0.30), { budget: 100000, riskPct: 2 });
  assert.deepEqual(s.alternatives.map(a => a.vehicle).sort(), ["call", "csp", "shares", "spread"]);
  for (const a of s.alternatives) assert.ok(allNumbersFinite(a.ev));
});

test("without a forecast the volatility part is unknown, not zero", () => {
  const { s } = plan(withOptions({ ivHvRatio: 0.8 }), { budget: 100000, riskPct: 2 });
  assert.equal(s.vehicle, "call");
  assert.equal(s.ev.volatility, null);
  const text = strategyText(s, plan(withOptions({ ivHvRatio: 0.8 })).e, context(base()), {});
  assert.match(text, /Expected value: [−+]\$/);
});

test("fractional shares let a small budget trade, sliced to 0.0001 of a share with a $1 minimum order", () => {
  const { s } = plan(base(), { budget: 40, riskPct: 2, instruments: "shares" });
  assert.equal(s.status, "act");
  assert.ok(s.qty > 0 && s.qty < 1, `qty ${s.qty}`);
  assert.equal(Math.round(s.qty * 1e4) / 1e4, s.qty, "cut to 0.0001 of a share");
  assert.ok(s.cost <= 40 && s.lossAtStop <= 0.8 + 1e-9);
  assert.match(orderLine(s, "TEST"), /^Buy 0\.\d+ TEST shares \(\$\d+\.\d{2}\)$/);

  const whole = plan(base(), { budget: 40, riskPct: 2, instruments: "shares", fractional: false }).s;
  assert.equal(whole.status, "pass");
  assert.match(whole.reason, /fractional/);

  // $1 budget at 0.1% risk can only lose $0.001 at a $1.50 stop distance: a tenth of a cent of stock, under $1.
  const tiny = plan(base(), { budget: 1, riskPct: 0.1, instruments: "shares" }).s;
  assert.equal(tiny.status, "pass");
  assert.equal(tiny.code, "too-small");
});

test("fractional is on unless switched off, and survives the string the limits bar sends", () => {
  assert.equal(normalizeStrategyPrefs({}).fractional, true);
  assert.equal(normalizeStrategyPrefs({ fractional: "false" }).fractional, false);
  assert.equal(normalizeStrategyPrefs({ fractional: false }).fractional, false);
  assert.equal(normalizeStrategyPrefs({ fractional: "true" }).fractional, true);
});
