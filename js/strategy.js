/**
 * Strategy: turns one stock's evaluation (js/engine.js) and the user's trading limits into a concrete order, sized so a
 * stop-out loses no more than the user's risk per trade, with an exit date and a 0-100 risk score.
 *
 * Entry, stop and target are the engine's levels; the vehicle follows the engine's options rule (implied volatility
 * against the GARCH forecast), with the user's spread limit in place of the engine's. The verdict decides whether the
 * order is for now (buy zone), a planned limit order at the preferred entry (strong / watch), or nothing (avoid).
 *
 * Expected value replaces reward/risk as the headline. A stop and a target only reshape the outcomes: with no drift,
 * every bracket is worth zero before costs, whatever its reward/risk, because the target is correspondingly less likely
 * to be reached first. So the expected value is built only from what can carry an edge, each part labelled with its
 * evidence: the signal model's expected return (js/edge.js), options priced against the volatility forecast, and the
 * costs of trading.
 *
 * Prices: the at-the-money call is a real Cboe quote. Every other option price (the short call of a spread, the put,
 * any option value at the stop or the target) is modeled with Black-Scholes at the chain's implied volatility, and
 * marked as modeled so the UI can say so.
 */
import { RULES, evaluateOptions, monthlySigma, optionsPricing } from "./engine.js";
import { filingActions } from "./developments.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DAY_MS = 864e5;

/** Approximate short-term Treasury yield for option pricing. A point either way moves a 45-day option by cents. */
const RISK_FREE = 0.04;
/** Long options lose value fastest in their last three weeks, so positions are closed before then. */
const CLOSE_BEFORE_EXPIRY_DAYS = 21;
/** A position that would have to close within this many days isn't worth opening. */
const MIN_HOLD_DAYS = 3;
const NEGATIVE_FILING_DAYS = 30;
/** Cost of trading shares, each way: about half a large-cap spread plus slippage at a commission-free broker. */
const SHARE_COST_PER_SIDE = 0.0005;
/** Fractional share orders: the smallest slice and the smallest order most brokers that offer them accept. */
const SHARE_STEP = 0.0001;
const MIN_FRACTIONAL_ORDER = 1;

export const STRATEGY_FIELDS = {
  budget: { min: 1, max: 1e8, default: 10000 },
  riskPct: { min: 0.1, max: 10, default: 1 },
  horizonDays: { min: 5, max: 120, default: 30 },
  maxSpreadPct: { min: 1, max: 25, default: RULES.maxSpreadPct }
};
export const INSTRUMENTS = [
  { key: "any", label: "Shares and options" },
  { key: "shares", label: "Shares only" }
];

/** Fills missing or invalid limits with defaults and clamps the rest to their range. */
export function normalizeStrategyPrefs(raw) {
  const prefs = {};
  for (const [key, f] of Object.entries(STRATEGY_FIELDS)) {
    const v = Number(raw?.[key]);
    prefs[key] = Number.isFinite(v) ? clamp(v, f.min, f.max) : f.default;
  }
  prefs.horizonDays = Math.round(prefs.horizonDays);
  prefs.instruments = INSTRUMENTS.some(i => i.key === raw?.instruments) ? raw.instruments : "any";
  // Fractional shares are on unless switched off: most retail brokers sell them, and they let small budgets trade.
  prefs.fractional = !(raw?.fractional === false || raw?.fractional === "false");
  return prefs;
}

/* ------------------------------------------------------------------ pricing */

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, error below 1e-7). */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = 0.3989422804014327 * Math.exp(-x * x / 2) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/** Black-Scholes value of a European call or put; `years` to expiry, `iv` annualized. */
export function blackScholes(kind, spot, strike, years, iv) {
  if (years <= 0 || iv <= 0) return Math.max(0, kind === "call" ? spot - strike : strike - spot);
  const sd = iv * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (RISK_FREE + iv * iv / 2) * years) / sd;
  const d2 = d1 - sd;
  const discounted = strike * Math.exp(-RISK_FREE * years);
  return kind === "call" ? spot * normCdf(d1) - discounted * normCdf(d2) : discounted * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Chance that price touches `stop` within `sessions`, for a driftless random walk at annual volatility `vol`
 * (reflection principle). Not a forecast: the same odds a coin-flip market would give.
 */
export function touchProbability(price, stop, vol, sessions) {
  if (!(price > stop) || !(vol > 0) || !(sessions > 0)) return null;
  return clamp(2 * normCdf(-Math.log(price / stop) / (vol * Math.sqrt(sessions / 252))), 0, 1);
}

/** Common listed strike spacing for a price. Real chains vary; the UI asks the user to check the strike. */
export const strikeStep = (price) => price < 25 ? 0.5 : price < 100 ? 1 : price < 500 ? 5 : 10;

/** The highest price at which a long position from `stop` to `target` still offers the buy zone's reward/risk. */
export const maxEntryPrice = (target, stop) => (target + RULES.buyZone.rewardRisk * stop) / (1 + RULES.buyZone.rewardRisk);

/* ------------------------------------------------------------------ dates */

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);
/** The same day if it is a weekday, otherwise the Friday before. Market holidays are not known here. */
const weekdayOnOrBefore = (d) => {
  const back = d.getDay() === 0 ? 2 : d.getDay() === 6 ? 1 : 0;
  return addDays(d, -back);
};
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ------------------------------------------------------------------ positions */

/**
 * Shares between entry and stop; worst case gaps one weekly move through the stop. With `fractional`, the quantity is
 * cut to SHARE_STEP and must come to at least MIN_FRACTIONAL_ORDER dollars; otherwise it is whole shares.
 */
function sharesPosition({ entry, stop, target, gapStop, riskBudget, budget, fractional }) {
  const most = Math.min(riskBudget / (entry - stop), budget / entry);
  let qty = fractional ? Math.floor(most / SHARE_STEP) * SHARE_STEP : Math.floor(most);
  qty = Math.round(qty * 1e4) / 1e4;
  if (fractional && qty * entry < MIN_FRACTIONAL_ORDER) qty = 0;
  return {
    vehicle: "shares", qty, unit: qty === 1 ? "share" : "shares", legs: [],
    cost: qty * entry, lossAtStop: qty * (entry - stop), worstLoss: qty * (entry - gapStop), gainAtTarget: qty * (target - entry), maxGain: null
  };
}

/** One long at-the-money call: the real ask, valued at the stop and the target on the close-by date. */
function callPosition({ o, stop, target, holdDays, riskBudget, budget }) {
  const ask = o.atmCallAsk;
  const left = Math.max(o.daysToExpiration - holdDays, 1) / 365;
  const atStop = blackScholes("call", stop, o.atmCallStrike, left, o.impliedVolatility);
  const atTarget = blackScholes("call", target, o.atmCallStrike, left, o.impliedVolatility);
  const qty = Math.floor(Math.min(riskBudget / ((ask - atStop) * 100), budget / (ask * 100)));
  return {
    vehicle: "call", qty, unit: qty === 1 ? "contract" : "contracts",
    legs: [{ side: "buy", kind: "call", strike: o.atmCallStrike, expiration: o.expiration, price: ask, iv: o.impliedVolatility, modeled: false }],
    cost: qty * ask * 100, lossAtStop: qty * (ask - atStop) * 100, worstLoss: qty * ask * 100,
    gainAtTarget: qty * (atTarget - ask) * 100, maxGain: null, perContract: ask * 100, lossPerContract: (ask - atStop) * 100
  };
}

/** Long the at-the-money call, short a modeled call at the target: gains capped at the target, cost and decay cut. */
function spreadPosition({ o, price, stop, target, holdDays, riskBudget, budget, relHalfSpread }) {
  const step = strikeStep(price);
  const long = o.atmCallStrike;
  const short = Math.max(long + step, Math.round(target / step) * step);
  const iv = o.impliedVolatility;
  const shortIv = isNum(o.call25Iv) ? o.call25Iv : iv;
  const now = o.daysToExpiration / 365;
  const shortBid = blackScholes("call", price, short, now, shortIv) * (1 - relHalfSpread);
  const debit = o.atmCallAsk - shortBid;
  const width = short - long;
  if (!(debit > 0 && debit < width)) return null;
  const left = Math.max(o.daysToExpiration - holdDays, 1) / 365;
  const value = (s) => blackScholes("call", s, long, left, iv) - blackScholes("call", s, short, left, shortIv);
  const lossPer = (debit - value(stop)) * 100;
  const qty = Math.floor(Math.min(riskBudget / lossPer, budget / (debit * 100)));
  return {
    vehicle: "spread", qty, unit: qty === 1 ? "spread" : "spreads",
    legs: [
      { side: "buy", kind: "call", strike: long, expiration: o.expiration, price: o.atmCallAsk, iv, modeled: false },
      { side: "sell", kind: "call", strike: short, expiration: o.expiration, price: shortBid, iv: shortIv, modeled: true }
    ],
    debit, cost: qty * debit * 100, lossAtStop: qty * lossPer, worstLoss: qty * debit * 100,
    gainAtTarget: qty * (value(target) - debit) * 100, maxGain: qty * (width - debit) * 100, perContract: debit * 100, lossPerContract: lossPer
  };
}

/**
 * A cash-secured put struck at the preferred entry: paid to wait for the price the engine wants. Bought back by the
 * close-by date like the other options, so the loss at the stop is the cost of buying it back there; the worst case is
 * that or, if larger, assignment followed by a gap through the stop.
 */
function putPosition({ o, price, entryZoneHigh, stop, target, gapStop, holdDays, riskBudget, budget, relHalfSpread }) {
  const step = strikeStep(price);
  let strike = Math.floor(Math.min(entryZoneHigh ?? price, price) / step) * step;
  if (strike <= stop) strike = Math.floor(price / step) * step;
  if (strike <= stop) return null;
  const iv = isNum(o.put25Iv) ? o.put25Iv : o.impliedVolatility;
  const premium = blackScholes("put", price, strike, o.daysToExpiration / 365, iv) * (1 - relHalfSpread);
  if (!(premium > 0.01)) return null;
  const left = Math.max(o.daysToExpiration - holdDays, 1) / 365;
  const lossPer = Math.max(0, blackScholes("put", stop, strike, left, iv) - premium) * 100;
  const qty = Math.floor(Math.min(budget / (strike * 100), lossPer > 0 ? riskBudget / lossPer : Infinity));
  return {
    vehicle: "csp", qty, unit: qty === 1 ? "contract" : "contracts",
    legs: [{ side: "sell", kind: "put", strike, expiration: o.expiration, price: premium, iv, modeled: true }],
    premium, cost: qty * strike * 100, lossAtStop: qty * lossPer, worstLoss: qty * Math.max(lossPer, (strike - premium - gapStop) * 100),
    gainAtTarget: qty * (premium - blackScholes("put", target, strike, left, iv)) * 100, maxGain: qty * premium * 100,
    perContract: strike * 100, lossPerContract: lossPer
  };
}

/* ------------------------------------------------------------------ expected value */

/**
 * Chance the price reaches `target` before `stop` from `entry`, for a driftless random walk in log price (gambler's
 * ruin). This is what reward/risk leaves out: a 10 : 1 bracket reaches its target about 1 time in 11.
 */
export function targetFirstProbability(entry, stop, target) {
  return entry > stop && target > entry ? Math.log(entry / stop) / Math.log(target / stop) : null;
}

/**
 * Expected value of a position over its hold, in dollars, from its three sources:
 *   signal      the model's expected return relative to the other stocks (js/edge.js), scaled to the hold
 *   volatility  options only: the value of the legs if the stock moves as the forecast expects during the hold and the
 *               market still prices the rest of their life at today's implied volatility, less their value at today's
 *               implied volatility. Positive when the options are cheap for the movement expected
 *   costs       crossing the spread to get in and out
 * `edge`: { expected, sessions } from signalReadings(), or null. The volatility part needs the build's forecast.
 * Returns { total, signal, volatility, costs, drift } with null for a part that can't be measured.
 */
function expectedValue(plan, item, edge, holdDays) {
  const sessions = holdDays * 252 / 365;
  const drift = isNum(edge?.expected) ? edge.expected * sessions / (edge.sessions ?? 21) : null;
  const d = drift ?? 0;
  if (plan.vehicle === "shares") {
    const signal = drift === null ? null : plan.cost * drift;
    const costs = plan.cost * 2 * SHARE_COST_PER_SIDE;
    return { total: (signal ?? 0) - costs, signal, volatility: null, costs, drift };
  }
  const o = item.options;
  const price = item.price;
  const life = o.daysToExpiration / 365;
  const held = Math.min(holdDays / 365, life);
  // The hold exits before earnings, so it lives through the forecast without earnings gaps; the market's price keeps
  // any release after the exit, so only the part of implied variance that isn't the release is compared with it.
  const forecast = item.volForecast?.diffusive21;
  const release = o.earningsMove > 0 && item.volForecast?.earningsInWindow ? o.earningsMove ** 2 : 0;
  let signal = 0, volatility = isNum(forecast) ? 0 : null, costs = 0;
  for (const leg of plan.legs) {
    const sign = leg.side === "buy" ? 1 : -1;
    const totalVariance = leg.iv ** 2 * life;
    const ordinary = Math.max(totalVariance - release, 0) / life;
    const atForecast = isNum(forecast) ? Math.sqrt(Math.max(totalVariance + held * (forecast ** 2 - ordinary), 1e-8) / life) : leg.iv;
    const now = blackScholes(leg.kind, price, leg.strike, life, leg.iv);
    const expectedNow = blackScholes(leg.kind, price, leg.strike, life, atForecast);
    if (volatility !== null) volatility += sign * (expectedNow - now) * 100 * plan.qty;
    signal += sign * (blackScholes(leg.kind, price * (1 + d), leg.strike, life, atForecast) - expectedNow) * 100 * plan.qty;
    costs += leg.price * (plan.spreadPct ?? 0) / 100 * 100 * plan.qty;
  }
  return { total: (drift === null ? 0 : signal) + (volatility ?? 0) - costs, signal: drift === null ? null : signal, volatility, costs, drift };
}

/* ------------------------------------------------------------------ risk score */

const factor = (label, detail, points, max) => ({ label, detail, points: clamp(points, 0, max), max });

/**
 * 0-100, higher is riskier: how much of the budget can go, how likely the stop is to be hit by ordinary noise, and
 * what around the position (volatility, events, market, setup, leverage, data) could make it worse than planned.
 */
function riskScore({ e, context, plan, prefs, holdDays, today, closeBy }) {
  const { item } = e;
  const factors = [];
  const share = plan.worstLoss / prefs.budget;
  factors.push(factor("Capital at risk", `worst case ${(share * 100).toFixed(1)}% of your budget`,
    share <= 0.025 ? 2 : share <= 0.05 ? 6 : share <= 0.10 ? 11 : share <= 0.25 ? 16 : 20, 20));

  const odds = plan.stopOdds;
  factors.push(isNum(odds)
    ? factor("Stop-out odds", `${Math.round(odds * 100)}% chance ordinary volatility touches the stop within ${holdDays} days`, Math.round(odds * 15), 15)
    : factor("Stop-out odds", "no 30-day volatility to measure it", 8, 15));

  const hv = item.hv30;
  factors.push(isNum(hv)
    ? factor("Volatility", `${(hv * 100).toFixed(0)}% annualized (30-day realized)`, hv < 0.20 ? 2 : hv < 0.35 ? 4 : hv < 0.50 ? 7 : 10, 10)
    : factor("Volatility", "no 30-day volatility", 6, 10));

  let event = 0;
  const events = [];
  const c = item.catalysts ?? {};
  const earnings = parseDay(c.nextEarningsDate);
  if (earnings && closeBy && earnings > today) {
    const gap = daysBetween(closeBy, earnings);
    // Only a planned order can have earnings inside its window: an order for now always exits the session before.
    if (gap < 0) { event += 8; events.push(`earnings ${c.nextEarningsDate} fall inside the holding period, so the position may have to close early`); }
    else if (gap <= 7 && c.earningsDateEstimated) { event += 10; events.push(`estimated earnings date ${c.nextEarningsDate} is ${gap} days after the exit and can move`); }
    else if (gap <= 7) { event += 5; events.push(`earnings ${c.nextEarningsDate} right after the exit`); }
  }
  const negative = filingActions(item).filter(a => a.tone === "negative" && daysBetween(parseDay(a.date) ?? today, today) <= NEGATIVE_FILING_DAYS);
  if (negative.length) { event += 6; events.push(`negative 8-K in the last ${NEGATIVE_FILING_DAYS} days (${negative[0].label})`); }
  factors.push(factor("Event risk", events.join("; ") || "no earnings near the exit, no negative 8-K", event, 15));

  factors.push(factor("Market backdrop", `${context.regime.toLowerCase()} regime`, { BULLISH: 0, NEUTRAL: 4, CAUTIOUS: 7, BEARISH: 10 }[context.regime] ?? 5, 10));

  const chase = e.diagnostics.chase;
  factors.push(factor("Setup", `${e.verdict.toLowerCase()}, chase risk ${chase.toLowerCase()}`,
    ({ buy: 0, strong: 5, watch: 9, avoid: 15 }[e.bucket] ?? 9) + ({ High: 4, Moderate: 2 }[chase] ?? 0), 15));

  const ratio = optionsPricing(item)?.ratio;
  const pricey = (plan.vehicle === "call" || plan.vehicle === "spread") && isNum(ratio) && ratio >= RULES.ivExpensiveRatio;
  factors.push(factor("Leverage and decay",
    { shares: "shares: no expiry, no leverage", call: "long call: leveraged, loses value every day", spread: "debit spread: leveraged, capped gain", csp: "short put: must buy the shares if assigned" }[plan.vehicle]
      + (pricey ? `; IV ${ratio.toFixed(2)}x realized` : ""),
    ({ shares: 0, csp: 3, spread: 5, call: 7 }[plan.vehicle] ?? 0) + (pricey ? 3 : 0), 10));

  const gaps = e.dataGaps.length;
  const optionSpread = plan.legs.length ? plan.spreadPct : null;
  const wide = isNum(optionSpread) && optionSpread > prefs.maxSpreadPct * 2 / 3;
  factors.push(factor("Liquidity and data",
    [wide ? `option spread ${optionSpread.toFixed(1)}%` : null, gaps ? `${gaps} missing input${gaps === 1 ? "" : "s"}` : null].filter(Boolean).join("; ") || "liquid, complete data",
    (wide ? 2 : 0) + (gaps >= 3 ? 3 : gaps ? 1 : 0), 5));

  const score = Math.round(factors.reduce((s, f) => s + f.points, 0));
  const [label, tone] = score < 25 ? ["Low", "pos"] : score < 45 ? ["Moderate", "warn"] : score < 65 ? ["High", "neg"] : ["Very high", "neg"];
  return { score, label, tone, factors };
}

/* ------------------------------------------------------------------ the strategy */

const STATUS = {
  act: { label: "Act now", tone: "pos" },
  plan: { label: "Planned order", tone: "warn" },
  pass: { label: "No trade", tone: "muted" }
};
export const VEHICLE_LABELS = { shares: "Shares", call: "Long call", spread: "Call debit spread", csp: "Cash-secured put" };

/** `code` says why without the figures in `reason`, which can quote an earnings date: avoid, no-stop, no-room, exit-too-soon, too-small. */
const pass = (code, reason, extra = {}) => ({ status: "pass", ...STATUS.pass, code, reason, risk: null, notes: [], ...extra });

/**
 * @param e an evaluateAsset() result
 * @param prefs the user's limits (normalizeStrategyPrefs fills gaps)
 * @param context buildMarketContext() result
 * @param now when the user is reading it; exit dates count from here, not from the build
 * @param edge this stock's signalReadings() entry plus the model's `sessions`, or null without a model
 * @returns { status: act|plan|pass, label, tone, code? and reason? (pass only), vehicle, qty, unit, legs, entry, limit, stop, target,
 *   closeBy (YYYY-MM-DD, act only), closeByReason, holdDays, cost, lossAtStop, worstLoss, gainAtTarget, maxGain,
 *   rewardRisk, targetFirst, ev: { total, signal, volatility, costs, drift }, alternatives: [{ vehicle, qty, unit,
 *   cost, lossAtStop, ev }] (act with options allowed), stopOdds, risk: { score, label, tone, factors }, notes[] }
 */
export function buildStrategy(e, prefs, context, now = new Date(), edge = null) {
  const p = normalizeStrategyPrefs(prefs);
  const { item, levels: lv } = e;
  const riskBudget = p.budget * p.riskPct / 100;
  const base = { prefs: p, riskBudget };

  if (e.bucket === "avoid") return pass("avoid", `The engine says ${e.verdict.toLowerCase()}. No long trade until that changes.`, base);
  if (!isNum(lv.entrySupport) || !isNum(lv.target)) return pass("no-stop", "No stop below the price, so a position can't be sized.", base);

  const act = e.bucket === "buy";
  const entry = act ? item.price : lv.zoneHigh;
  const stop = lv.entrySupport;
  const target = lv.target;
  if (!(entry > stop) || !(target > entry)) return pass("no-room", "No room between the stop and the target from the preferred entry.", base);

  const today = startOfDay(now);
  const notes = [];
  const weekly = monthlySigma(item) * Math.sqrt(5 / 21);
  const gapStop = stop * (1 - weekly);
  const earnings = parseDay(item.catalysts?.nextEarningsDate);
  const beforeEarnings = earnings && earnings > today ? weekdayOnOrBefore(addDays(earnings, -1)) : null;

  // Exit date: the user's holding period, cut short by earnings and, for options, by the last three weeks before expiry.
  const exitAt = (closeBy, closeByReason) => ({ closeBy, closeByReason, holdDays: act ? Math.max(daysBetween(today, closeBy), 0) : p.horizonDays });
  let exit = exitAt(weekdayOnOrBefore(addDays(today, p.horizonDays)), "end of your holding period");
  if (act && beforeEarnings && beforeEarnings < exit.closeBy) {
    exit = exitAt(beforeEarnings, `the session before earnings (${item.catalysts.nextEarningsDate}${item.catalysts.earningsDateEstimated ? ", estimated" : ""})`);
  }
  const sharesExit = exit;

  // Options only for an order placed now: the chain was quoted at today's price, not at a future entry.
  const o = item.options;
  let vehicle = "shares";
  let optionsNote = null;
  let spreadPct = null;
  let optionExit = null;
  if (act && p.instruments === "any" && o && isNum(o.atmCallAsk) && o.atmCallAsk > 0 && isNum(o.impliedVolatility)) {
    spreadPct = (o.atmCallAsk - o.atmCallBid) / o.atmCallAsk * 100;
    const pick = evaluateOptions(item, true, e.earningsWarning, p.maxSpreadPct).recommendation;
    const expiry = parseDay(o.expiration);
    const optionClose = expiry ? weekdayOnOrBefore(addDays(expiry, -CLOSE_BEFORE_EXPIRY_DAYS)) : null;
    if (pick === "SHARES") optionsNote = `Options skipped: the at-the-money call's spread (${spreadPct.toFixed(1)}%) or open interest (${o.atmCallOpenInterest}) misses your limits.`;
    else if (!optionClose || daysBetween(today, optionClose) < MIN_HOLD_DAYS) optionsNote = `Options skipped: the ${o.expiration} expiration is too close to hold.`;
    else {
      vehicle = { "LONG CALL OR CALL DEBIT SPREAD": "call", "CALL DEBIT SPREAD": "spread", "CASH-SECURED PUT OR SHARES": "csp" }[pick] ?? "shares";
      optionExit = optionClose < exit.closeBy
        ? exitAt(optionClose, `${CLOSE_BEFORE_EXPIRY_DAYS} days before the ${o.expiration} expiration, when time decay speeds up`)
        : exit;
      if (vehicle !== "shares") exit = optionExit;
    }
  } else if (act && p.instruments === "shares") {
    optionsNote = "Shares only, as you set.";
  }

  const inputs = { o, price: item.price, entry, entryZoneHigh: lv.zoneHigh, stop, target, gapStop, riskBudget, budget: p.budget, fractional: p.fractional,
    relHalfSpread: isNum(spreadPct) ? spreadPct / 200 : 0 };
  let plan = null;
  if (vehicle !== "shares") {
    const build = { call: callPosition, spread: spreadPosition, csp: putPosition }[vehicle];
    plan = build({ ...inputs, holdDays: exit.holdDays });
    if (plan && plan.qty < 1) {
      const dollars = (v) => `$${Math.round(v).toLocaleString("en-US")}`;
      const name = VEHICLE_LABELS[plan.vehicle].toLowerCase();
      notes.push(plan.perContract > p.budget
        ? `One ${name} ${plan.vehicle === "csp" ? "ties up" : "costs"} ${dollars(plan.perContract)}, over your ${dollars(p.budget)} budget, so this uses shares.`
        : `One ${name} would lose about ${dollars(plan.lossPerContract)} at the stop, over your ${dollars(riskBudget)} risk per trade, so this uses shares.`);
      plan = null;
    } else if (!plan) {
      notes.push(`The modeled ${VEHICLE_LABELS[vehicle].toLowerCase()} doesn't price sensibly here, so this uses shares.`);
    }
  }
  if (!plan) {
    exit = sharesExit;
    plan = sharesPosition(inputs);
    if (optionsNote) notes.push(optionsNote);
  }
  const { closeBy, closeByReason, holdDays } = exit;
  if (act && holdDays < MIN_HOLD_DAYS) return pass("exit-too-soon", `Exit would fall within ${MIN_HOLD_DAYS} days (${closeByReason}). Not worth opening.`, base);
  if (!(plan.qty > 0)) {
    return pass("too-small", p.fractional
      ? `Your risk per trade buys less than $${MIN_FRACTIONAL_ORDER} of stock with the stop at ${stop.toFixed(2)}, below the usual minimum order.`
      : `Your budget and risk per trade don't cover one whole share at ${entry.toFixed(2)} with the stop at ${stop.toFixed(2)}. Allowing fractional shares would.`, base);
  }

  plan.spreadPct = spreadPct;
  plan.stopOdds = touchProbability(entry, stop, item.hv30, holdDays * 252 / 365);
  if (plan.legs.some(l => l.modeled)) notes.push("Prices marked “modeled” are Black-Scholes estimates at the chain's implied volatility, not quotes. Check the live chain and the strike before ordering.");
  if (!act) {
    notes.push(lv.distanceFromIdeal > 0
      ? `Today's price is ${(lv.distanceFromIdeal * 100).toFixed(1)}% above the preferred entry. Place this once the stock reaches the buy zone; options are chosen then, from the chain at that price.`
      : "The price is in the preferred entry zone, but the verdict isn't a buy yet. Place this once it is; options are chosen then.");
    if (beforeEarnings && daysBetween(today, beforeEarnings) <= p.horizonDays) notes.push(`Earnings on ${item.catalysts.nextEarningsDate}: exit the day before if it fills first.`);
  }
  // Every vehicle that fits the limits, with its expected value, so the rule's pick can be weighed against the others.
  const POSITIONS = { shares: sharesPosition, call: callPosition, spread: spreadPosition, csp: putPosition };
  const alternatives = [];
  if (optionExit) {
    for (const v of Object.keys(POSITIONS)) {
      const ex = v === "shares" ? sharesExit : optionExit;
      const pos = POSITIONS[v]({ ...inputs, holdDays: ex.holdDays });
      if (!pos || pos.qty < 1 || ex.holdDays < MIN_HOLD_DAYS) continue;
      pos.spreadPct = spreadPct;
      alternatives.push({ vehicle: v, qty: pos.qty, unit: pos.unit, cost: pos.cost, lossAtStop: pos.lossAtStop, ev: expectedValue(pos, item, edge, ex.holdDays) });
    }
  }

  const ageDays = (now - new Date(item.asOf)) / DAY_MS;
  if (ageDays > 3) notes.push(`These prices are ${Math.round(ageDays)} days old. Recheck the levels before ordering.`);

  const limit = act ? maxEntryPrice(target, stop) : entry;

  const result = {
    status: act ? "act" : "plan", ...STATUS[act ? "act" : "plan"], ...base, ...plan,
    entry, limit, stop, target, targetSource: lv.targetSource,
    closeBy: act ? isoDay(closeBy) : null, closeByReason: act ? closeByReason : null, holdDays,
    rewardRisk: plan.lossAtStop > 0 ? plan.gainAtTarget / plan.lossAtStop : null,
    targetFirst: targetFirstProbability(entry, stop, target),
    ev: expectedValue(plan, item, edge, holdDays),
    alternatives,
    notes
  };
  result.risk = riskScore({ e, context, plan: result, prefs: p, holdDays, today, closeBy: act ? closeBy : addDays(today, holdDays) });
  return result;
}

/* ------------------------------------------------------------------ text */

const usd = (v) => isNum(v) ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "N/A";
const strikeText = (v) => `$${+v.toFixed(2)}`;
const pctText = (v) => isNum(v) ? `${(v * 100).toFixed(1)}%` : "N/A";
const signedUsd = (v) => isNum(v) ? `${v < 0 ? "−" : "+"}${usd(Math.abs(v))}` : "N/A";
const signedPct = (v) => isNum(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%` : "N/A";
/** "Nov 20, 2026" for an ISO day, read at local noon so no time zone moves it a day. */
export const expiryText = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The order in one line, e.g. "Buy 2 MSFT Nov 20, 2026 $495/$555 call spreads". Plain text; callers escape it for HTML. */
export function orderLine(s, ticker) {
  if (s.status === "pass") return "No trade";
  const many = s.qty === 1 ? "" : "s";
  const [first, second] = s.legs;
  return {
    shares: () => Number.isInteger(s.qty) ? `Buy ${s.qty} ${ticker} share${many}` : `Buy ${+s.qty.toFixed(4)} ${ticker} shares (${usd(s.cost)})`,
    call: () => `Buy ${s.qty} ${ticker} ${expiryText(first.expiration)} ${strikeText(first.strike)} call${many}`,
    spread: () => `Buy ${s.qty} ${ticker} ${expiryText(first.expiration)} ${strikeText(first.strike)}/${strikeText(second.strike)} call spread${many}`,
    csp: () => `Sell ${s.qty} ${ticker} ${expiryText(first.expiration)} ${strikeText(first.strike)} put${many}, cash-secured`
  }[s.vehicle]();
}

/**
 * The strategy as plain text for pasting into an AI agent or a note: every figure the Strategy section shows, the risk
 * factors with their readings, and the context an agent needs to judge it (verdict, scores, regime, data age).
 * @param s buildStrategy() result
 * @param e the evaluateAsset() result it was built from
 * @param context buildMarketContext() result
 * @param source { generatedAt, url, model } of the data build, the page and the signal model's label
 */
export function strategyText(s, e, context, { generatedAt, url, model } = {}) {
  const { item } = e;
  const p = s.prefs;
  const lines = [
    `StockWatcher strategy for ${item.ticker}${item.name ? ` (${item.name})` : ""}`,
    `Data built ${generatedAt ?? "N/A"}; price as of ${item.asOf ?? "N/A"}. Rule-based research, not investment advice.`,
    "",
    `Status: ${s.label}`,
    `Verdict: ${e.verdict}. Overall ${e.overall ?? "N/A"} (Quality ${e.scores.quality.score ?? "N/A"}, Trend ${e.scores.trend.score}, Entry ${e.scores.entry.score}, Trade ${e.scores.trade.score}). Market regime ${context.regime}. Chase risk ${e.diagnostics.chase}.`
  ];
  const limits = `Limits: ${usd(p.budget)} budget per trade, ${p.riskPct}% risk per trade (${usd(s.riskBudget)}), ${p.horizonDays}-day holding period, ${p.maxSpreadPct}% max option spread, ${INSTRUMENTS.find(i => i.key === p.instruments).label.toLowerCase()}, ${p.fractional ? "fractional shares allowed" : "whole shares only"}.`;

  if (s.status === "pass") {
    lines.push(`Order: No trade. ${s.reason}`, "", limits);
  } else {
    lines.push(`Order: ${orderLine(s, item.ticker)} (${VEHICLE_LABELS[s.vehicle].toLowerCase()})`);
    if (s.status === "plan") {
      lines.push(`When: once it reaches the buy zone, limit ${usd(s.entry)} (the top of the preferred entry zone, ${signedPct(s.entry / item.price - 1)} from the last price ${usd(item.price)}). Hold up to ${s.holdDays} days after it fills.`);
    } else if (s.vehicle === "shares") {
      lines.push(`Limit: ${usd(item.price)}; don't pay above ${usd(s.limit)} (reward/risk falls below 1.5 : 1 there).`);
    } else if (s.vehicle === "csp") {
      lines.push(`Credit: about ${usd(s.premium)} per share; ${usd(s.perContract)} cash set aside per contract. Stock at ${usd(item.price)}.`);
    } else {
      lines.push(`${s.vehicle === "spread" ? `Debit: about ${usd(s.debit)}` : `Limit: ${usd(s.legs[0].price)}`} per share (${usd(s.perContract)} per contract). Stock at ${usd(item.price)}.`);
    }
    for (const l of s.legs) {
      lines.push(`- ${l.side === "buy" ? "Buy" : "Sell"} ${s.qty} x ${item.ticker} ${l.expiration} ${strikeText(l.strike)} ${l.kind} @ ${usd(l.price)} (${l.modeled ? "modeled with Black-Scholes, not a quote" : "delayed quote"})`);
    }
    lines.push(
      `Exit: ${s.closeBy ? `close by ${s.closeBy} (${s.closeByReason}), ` : ""}on a daily close below the stop ${usd(s.stop)} (${signedPct(s.stop / s.entry - 1)}), or at the target ${usd(s.target)} (${signedPct(s.target / s.entry - 1)}, ${s.targetSource}).`,
      "",
      "Figures:",
      `- ${s.vehicle === "csp" ? "Cash set aside" : "Capital used"}: ${usd(s.cost)} (${pctText(s.cost / p.budget)} of budget)`,
      `- Loss at stop: ${usd(s.lossAtStop)} (${pctText(s.lossAtStop / p.budget)} of budget)`,
      `- Worst case: ${usd(s.worstLoss)} (${pctText(s.worstLoss / p.budget)} of budget)`,
      `- Gain at target: ${usd(s.gainAtTarget)}${isNum(s.maxGain) ? `; max ${usd(s.maxGain)}` : ""}`,
      `- Reward/risk: ${isNum(s.rewardRisk) ? `${s.rewardRisk.toFixed(1)} : 1` : "N/A"}; with no drift the target is reached before the stop ${isNum(s.targetFirst) ? pctText(s.targetFirst) : "N/A"} of the time, so the bracket alone adds no value`,
      "",
      `Expected value: ${signedUsd(s.ev.total)} after costs`,
      `- Signal (unproven): ${signedUsd(s.ev.signal)}${isNum(s.ev.drift) ? `; ${model ?? "the frozen model"} expects ${signedPct(s.ev.drift)} over the hold relative to the other tracked stocks` : "; no signal model"}`,
      ...(s.vehicle === "shares" ? [] : [`- Volatility (untested against implied volatility): ${signedUsd(s.ev.volatility)}; options priced against the GJR-GARCH volatility forecast`]),
      `- Costs (estimate): ${signedUsd(isNum(s.ev.costs) ? -s.ev.costs : null)}`,
      ...(s.alternatives.length > 1 ? [`- By vehicle, each sized to the limits: ${s.alternatives.map(a => `${VEHICLE_LABELS[a.vehicle]} ${signedUsd(a.ev.total)}`).join(", ")} (the rule picked ${VEHICLE_LABELS[s.vehicle].toLowerCase()})`] : []),
      "",
      `Risk score: ${s.risk.score}/100 (${s.risk.label}; higher is riskier)`,
      ...s.risk.factors.map(f => `- ${f.label} ${f.points}/${f.max}: ${f.detail}`),
      "",
      ...(s.notes.length ? ["Notes:", ...s.notes.map(n => `- ${n}`), ""] : []),
      limits
    );
  }
  lines.push(
    `Missing inputs: ${e.dataGaps.join(", ") || "none"}.`,
    "Caveat: sizing isn't a forecast. The verdicts behind it haven't shown an edge in StockWatcher's replay backtests yet.",
    ...(url ? [`Source: ${url}`] : [])
  );
  return lines.join("\n");
}
