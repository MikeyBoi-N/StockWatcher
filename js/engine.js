/**
 * StockWatcher deterministic scoring engine.
 *
 * Pure functions over stock records from data/market.json (built by scripts/build_market_data.py). Four separate
 * 0-100 scores answer different questions, so a great company at a poor price reads as exactly that:
 *   Quality - is this a strong business?              SEC fundamentals, analyst estimate revisions
 *   Trend   - is the stock in a healthy uptrend?      moving averages, returns vs SPY, RSI, market regime
 *   Entry   - is today's price a good place to buy?   distance to entry support and resistance in volatility units, stretch, RSI
 *   Trade   - is the risk/reward worth taking now?    reward vs risk, valuation, earnings timing, options conditions
 * Overall is a weighted blend for sorting. Verdicts come from the four scores, never from Overall.
 *
 * Every score is a sum of named factors ({label, detail, points, max}) so the UI can show exactly how it was built.
 * A missing input scores its factor's midpoint and is listed in dataGaps. Headlines and 8-K events are never scored.
 */

export const RULES = {
  weights: { quality: 0.30, trend: 0.25, entry: 0.25, trade: 0.20 },
  buyZone: { entry: 75, trend: 60, quality: 60, trade: 60, rewardRisk: 1.5 },
  strongAsset: { quality: 65, trend: 55, etfTrend: 65 },
  avoid: { quality: 40, trend: 35 },
  goodScore: 70,
  weakScore: 45,
  earningsWarningDays: 14,
  extendedAbove50: 0.12,
  extendedAbove200: 0.22,
  richPe: 40,
  extremePe: 60,
  ivExpensiveRatio: 1.3,
  ivCheapRatio: 0.9,
  minOpenInterest: 500,
  maxSpreadPct: 6
};

export const SCORE_KEYS = ["quality", "trend", "entry", "trade"];
export const SCORE_LABELS = { overall: "Overall", quality: "Quality", trend: "Trend", entry: "Entry", trade: "Trade" };

export const VERDICT_LABELS = {
  buy: "Buy zone",
  strongEntry: "Strong asset, poor entry",
  strongTrade: "Strong asset, poor risk/reward",
  strongEarnings: "Strong asset, wait for earnings",
  watch: "Watch",
  avoidTrend: "Avoid, broken trend",
  avoidQuality: "Avoid, weak business"
};

const REGIME_POINTS = { BULLISH: 15, NEUTRAL: 10, CAUTIOUS: 5, BEARISH: 0 };
const DEFAULT_MONTHLY_SIGMA = 0.08;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;
const signed = (v, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(digits)}%`;
const usd = (v) => `$${v.toFixed(2)}`;

/** One month's typical move as a fraction of price, from 30-day realized volatility. */
export const monthlySigma = (item) => isNum(item.hv30) && item.hv30 > 0 ? item.hv30 * Math.sqrt(21 / 252) : DEFAULT_MONTHLY_SIGMA;
const weeklySigma = (item) => monthlySigma(item) * Math.sqrt(5 / 21);

/** Return relative to SPY over the same window, e.g. 0.05 = beat SPY by 5%. */
export function relativeToSpy(item, spy, key) {
  const r = item?.[key];
  const s = spy?.[key];
  return isNum(r) && isNum(s) && s > -1 ? (1 + r) / (1 + s) - 1 : null;
}

const factor = (label, detail, points, max) => ({ label, detail, points, max, missing: false });
const missingFactor = (label, max) => ({ label, detail: "No data (scored at the midpoint)", points: max / 2, max, missing: true });
const scoreFrom = (factors) => {
  const max = factors.reduce((s, f) => s + f.max, 0);
  return max ? clamp(Math.round(factors.reduce((s, f) => s + f.points, 0) / max * 100), 0, 100) : null;
};
const tier = (value, steps) => steps.find(([min]) => value >= min)[1];

/* ------------------------------------------------------------------ market context */

export function determineMarketRegime(records) {
  const spy = records.find(x => x.ticker === "SPY");
  const qqq = records.find(x => x.ticker === "QQQ");
  const ready = [spy, qqq].every(x => x && isNum(x.sma50) && isNum(x.sma200));
  if (!ready) return { regime: "NEUTRAL", description: "SPY/QQQ moving averages unavailable; regime assumed neutral." };

  const above200 = [spy, qqq].map(x => x.price > x.sma200);
  const above50 = [spy, qqq].map(x => x.price > x.sma50);
  if (above200.every(Boolean) && above50.every(Boolean)) {
    return { regime: "BULLISH", description: "SPY and QQQ are both above their 50d and 200d SMAs." };
  }
  if (above200.every(Boolean)) {
    return { regime: "NEUTRAL", description: "Both indices hold their 200d SMAs but are digesting 50d SMA support." };
  }
  if (above200.every(x => !x)) {
    return { regime: "BEARISH", description: "SPY and QQQ are both below their 200d SMAs. Capital preservation first." };
  }
  return { regime: "CAUTIOUS", description: "SPY and QQQ disagree on the long-term trend. Distribution risk." };
}

/**
 * Everything stocks are judged against, computed once per snapshot.
 * @param {object[]} records every tracked stock record
 * @param {object} sectors data/market.json `sectors` ({sector: {etf, price, sma50, return3m, ...}})
 */
export function buildMarketContext(records, sectors = {}) {
  const { regime, description } = determineMarketRegime(records);
  const spy = records.find(r => r.ticker === "SPY") ?? null;
  const stocks = records.filter(r => !r.etf && isNum(r.sma50));
  const share = (test) => stocks.length ? stocks.filter(test).length / stocks.length : null;
  const breadthNow = share(r => r.price > r.sma50);
  const withPrior = stocks.filter(r => isNum(r.sma50Prior) && isNum(r.close21Prior));
  const breadthPrior = withPrior.length >= stocks.length * 0.8 && withPrior.length
    ? withPrior.filter(r => r.close21Prior > r.sma50Prior).length / withPrior.length
    : null;
  return { regime, regimeDescription: description, spy, sectors: sectors ?? {}, breadthNow, breadthPrior, trackedStocks: stocks.length };
}

/* ------------------------------------------------------------------ levels */

/**
 * Trading levels. Entry support (nearest tradable level, from the build) is the trade stop; structural support
 * (the one-year swing low) is where the longer-term thesis breaks. Older snapshots without entrySupport fall back
 * to structural support.
 */
export function computeLevels(item) {
  const price = item.price;
  const structural = isNum(item.majorSupport) ? item.majorSupport : null;
  let entrySupport = isNum(item.entrySupport) ? item.entrySupport : structural;
  let entryMethod = isNum(item.entrySupport) ? item.entrySupportMethod : "structural";
  // A price already below entry support (a stress test, or a drop since the build) trades against the next level down.
  if (isNum(entrySupport) && entrySupport >= price) {
    entrySupport = isNum(structural) && structural < price ? structural : (isNum(item.low52) && item.low52 < price ? item.low52 : null);
    entryMethod = entrySupport === structural ? "structural" : "52-week low";
  }
  const resistance = isNum(item.majorResistance) && item.majorResistance > price * 1.005 ? item.majorResistance : null;
  const analystTarget = item.catalysts?.oneYearTarget;
  const target = resistance ?? (isNum(analystTarget) && analystTarget > price * 1.02 ? analystTarget : price * (1 + monthlySigma(item)));
  const targetSource = resistance ? "resistance" : isNum(analystTarget) && analystTarget > price * 1.02 ? "analyst target" : "one-month expected move";

  const upside = target / price - 1;
  const downside = isNum(entrySupport) ? (price - entrySupport) / price : null;
  const rewardRisk = isNum(downside) && downside > 0.002 ? upside / downside : null;
  const zoneLow = isNum(entrySupport) ? entrySupport * 1.0025 : null;
  const zoneHigh = isNum(entrySupport) ? entrySupport * (1 + Math.max(0.01, 0.35 * weeklySigma(item))) : null;
  return {
    entrySupport, entryMethod, structural, resistance, target, targetSource,
    upside, downside, rewardRisk, zoneLow, zoneHigh,
    distanceFromIdeal: isNum(zoneHigh) ? Math.max(0, price / zoneHigh - 1) : null,
    toStructural: isNum(structural) ? (price - structural) / price : null
  };
}

/* ------------------------------------------------------------------ labels shared by scores and diagnostics */

export function valuationLabel(item) {
  const v = item.valuation || {};
  const pe = isNum(v.forwardPe) ? v.forwardPe : v.trailingPe;
  if (!isNum(pe)) return null;
  if (pe <= 0) return "Unprofitable";
  if (pe > RULES.extremePe) return "Extreme";
  const hist = isNum(v.historical5yPe) && v.historical5yPe >= 5 && v.historical5yPe <= RULES.extremePe ? v.historical5yPe : null;
  if (pe > RULES.richPe || (hist && pe >= hist * 1.25)) return "Expensive";
  if ((hist && pe <= hist * 0.85) || pe < 12) return "Cheap";
  return "Fair";
}

export function pegLabel(item) {
  const peg = item.valuation?.pegRatio;
  if (!isNum(peg) || peg <= 0) return null;
  return peg <= 1.2 ? "Attractive" : peg <= 2 ? "Fair" : "Stretched";
}

const earningsInWindow = (item) => isNum(item.catalysts?.daysToEarnings) && item.catalysts.daysToEarnings <= RULES.earningsWarningDays;

/* ------------------------------------------------------------------ the four scores */

export function scoreQuality(item) {
  const f = item.fundamentals;
  if (!f) return { score: null, available: false, factors: [], gaps: item.etf ? [] : ["SEC fundamentals"] };
  const factors = [];
  const add = (label, value, max, fn) => factors.push(isNum(value) ? fn(value) : missingFactor(label, max));

  add("Revenue growth", f.revenueGrowthYoY, 20, v => factor("Revenue growth", `${signed(v)} YoY`, tier(v, [[0.20, 20], [0.10, 15], [0.05, 10], [0, 5], [-Infinity, 0]]), 20));
  add("Operating margin", f.operatingMargin, 20, v => factor("Operating margin", pct(v), tier(v, [[0.30, 20], [0.20, 15], [0.10, 10], [0, 5], [-Infinity, 0]]), 20));
  add("Margin trend", f.operatingMarginChange, 10, v => factor("Margin trend", `${signed(v)} YoY`, v >= 0.01 ? 10 : v > -0.01 ? 6 : 2, 10));
  add("Earnings growth", f.earningsGrowthYoY, 15, v => factor("Earnings growth", `${signed(v)} YoY`, tier(v, [[0.25, 15], [0.10, 11], [0, 7], [-Infinity, 2]]), 15));
  add("Free cash flow", f.freeCashFlow, 10, v => factor("Free cash flow", v < 0 ? "negative" : f.fcfTrend ? `positive, ${f.fcfTrend}` : "positive",
    v < 0 ? 0 : f.fcfTrend === "growing" ? 10 : f.fcfTrend === "shrinking" ? 5 : 7, 10));
  // Leverage ratios aren't meaningful for banks and insurers (deposits and float are funding, not debt).
  if (!/financ/i.test(item.sector || "")) {
    add("Balance sheet", f.netDebtToEbitda, 10, v => factor("Balance sheet", `${v.toFixed(1)}x net debt/EBITDA`, tier(-v, [[-0.5, 10], [-1.5, 8], [-2.5, 5], [-Infinity, 0]]), 10));
  }
  const c = item.catalysts || {};
  const net = isNum(c.revisionsUp) && isNum(c.revisionsDown) ? c.revisionsUp - c.revisionsDown : null;
  add("Analyst revisions", net, 15, v => factor("Analyst revisions", `${c.revisionsUp} up / ${c.revisionsDown} down (4 weeks)`, v >= 2 ? 15 : v >= 0 ? 9 : v > -2 ? 6 : 2, 15));

  return { score: scoreFrom(factors), available: true, factors, gaps: factors.filter(x => x.missing).map(x => x.label.toLowerCase()) };
}

export function scoreTrend(item, context) {
  const factors = [];
  const above = (label, a, b, max, text) => factors.push(isNum(a) && isNum(b) ? factor(label, text(a > b), a > b ? max : 0, max) : missingFactor(label, max));
  above("Long-term trend", item.price, item.sma200, 20, up => up ? "above 200-day SMA" : "below 200-day SMA");
  above("50-day vs 200-day", item.sma50, item.sma200, 15, up => up ? "50-day above 200-day" : "50-day below 200-day");
  above("Price vs 50-day", item.price, item.sma50, 10, up => up ? "above 50-day SMA" : "below 50-day SMA");

  const spy = context.spy;
  const rs = (label, field, steps, max) => {
    const rel = item.ticker === "SPY" ? 0 : relativeToSpy(item, spy, field);
    factors.push(isNum(rel) ? factor(label, item.ticker === "SPY" ? "is the benchmark" : `${signed(rel)} vs SPY`, tier(rel, steps), max) : missingFactor(label, max));
  };
  rs("3-month relative strength", "return3m", [[0.10, 15], [0.03, 11], [-0.03, 7], [-0.10, 3], [-Infinity, 0]], 15);
  rs("12-month relative strength", "return12m", [[0.15, 15], [0.05, 11], [-0.05, 7], [-0.15, 3], [-Infinity, 0]], 15);

  const rsi = item.rsi14;
  factors.push(isNum(rsi)
    ? factor("Momentum (RSI)", rsi.toFixed(1), rsi > 80 ? 4 : rsi > 70 ? 7 : rsi >= 50 ? 10 : rsi >= 40 ? 5 : 1, 10)
    : missingFactor("Momentum (RSI)", 10));
  factors.push(factor("Market regime", context.regime.toLowerCase(), REGIME_POINTS[context.regime] ?? 10, 15));
  return { score: scoreFrom(factors), available: true, factors, gaps: factors.filter(x => x.missing).map(x => x.label.toLowerCase()) };
}

export function scoreEntry(item, levels) {
  const sigma = monthlySigma(item);
  const inSigma = (v) => v / sigma;
  const factors = [];

  if (!isNum(levels.entrySupport)) {
    factors.push(missingFactor("Distance to entry support", 35));
  } else {
    // Entry support is the nearest tradable level, so distance is judged in weekly moves to stay selective.
    const d = levels.downside / weeklySigma(item);
    factors.push(factor("Distance to entry support", `${pct(levels.downside)} above ${usd(levels.entrySupport)} (${d.toFixed(2)} weekly moves)`,
      tier(d, [[2.5, 4], [1.5, 10], [1, 18], [0.5, 26], [-Infinity, 35]]), 35));
  }

  if (isNum(item.sma50)) {
    const dist = (item.price - item.sma50) / item.sma50;
    const s = inSigma(dist);
    factors.push(factor("Stretch above 50-day", `${signed(dist)} (${s.toFixed(2)} monthly moves)`,
      s < -1 ? 10 : s <= 0.5 ? 20 : s <= 1 ? 14 : s <= 1.5 ? 8 : 2, 20));
  } else {
    factors.push(missingFactor("Stretch above 50-day", 20));
  }

  if (isNum(item.sma200)) {
    const dist = (item.price - item.sma200) / item.sma200;
    factors.push(factor("Stretch above 200-day", signed(dist), dist < 0 ? 6 : dist <= 0.10 ? 15 : dist <= RULES.extendedAbove200 ? 10 : dist <= 0.35 ? 5 : 0, 15));
  } else {
    factors.push(missingFactor("Stretch above 200-day", 15));
  }

  const rsi = item.rsi14;
  factors.push(isNum(rsi)
    ? factor("RSI at entry", rsi.toFixed(1), rsi > 75 ? 0 : rsi > 68 ? 5 : rsi > 60 ? 11 : rsi >= 40 ? 15 : rsi >= 30 ? 10 : 7, 15)
    : missingFactor("RSI at entry", 15));

  factors.push(levels.resistance
    ? factor("Room to resistance", `${signed(levels.upside)} to ${usd(levels.resistance)}`, tier(inSigma(levels.upside), [[1, 15], [0.5, 10], [-Infinity, 4]]), 15)
    : factor("Room to resistance", "above all overhead resistance", 10, 15));

  return { score: scoreFrom(factors), available: true, factors, gaps: factors.filter(x => x.missing).map(x => x.label.toLowerCase()) };
}

export function scoreTrade(item, levels) {
  const factors = [];
  factors.push(isNum(levels.rewardRisk)
    ? factor("Reward vs risk", `${levels.rewardRisk.toFixed(1)} : 1 (${signed(levels.upside)} to ${levels.targetSource}, −${pct(levels.downside)} to stop)`,
      tier(levels.rewardRisk, [[3, 30], [2, 24], [1.5, 17], [1, 10], [-Infinity, 3]]), 30)
    : factor("Reward vs risk", "no defined stop below price", 3, 30));

  const valuation = valuationLabel(item);
  factors.push(valuation
    ? factor("Valuation", valuation, { Cheap: 20, Fair: 13, Expensive: 6, Extreme: 0, Unprofitable: 3 }[valuation], 20)
    : missingFactor("Valuation", 20));
  const peg = pegLabel(item);
  factors.push(peg ? factor("Valuation vs growth", `PEG ${item.valuation.pegRatio.toFixed(2)} (${peg.toLowerCase()})`, { Attractive: 10, Fair: 6, Stretched: 2 }[peg], 10) : missingFactor("Valuation vs growth", 10));

  const t = item.catalysts?.oneYearTarget;
  factors.push(isNum(t)
    ? factor("Analyst target", `${signed(t / item.price - 1)} to ${usd(t)}`, tier(t / item.price - 1, [[0.15, 10], [0, 6], [-0.05, 3], [-Infinity, 0]]), 10)
    : missingFactor("Analyst target", 10));

  factors.push(earningsInWindow(item)
    ? factor("Earnings timing", `earnings in ${item.catalysts.daysToEarnings} days`, 0, 15)
    : factor("Earnings timing", isNum(item.catalysts?.daysToEarnings) ? `earnings in ${item.catalysts.daysToEarnings} days` : "no earnings inside 14 days", 15, 15));

  const o = item.options;
  if (!o || !isNum(o.atmCallAsk) || o.atmCallAsk <= 0) {
    factors.push(missingFactor("Options conditions", 15));
  } else {
    const spreadPct = (o.atmCallAsk - o.atmCallBid) / o.atmCallAsk * 100;
    const liquid = o.atmCallOpenInterest >= RULES.minOpenInterest && spreadPct <= RULES.maxSpreadPct;
    const expensive = isNum(o.ivHvRatio) && o.ivHvRatio >= RULES.ivExpensiveRatio;
    factors.push(factor("Options conditions",
      !liquid ? `illiquid (OI ${o.atmCallOpenInterest}, spread ${spreadPct.toFixed(1)}%)` : expensive ? `liquid, IV ${o.ivHvRatio.toFixed(2)}x realized (expensive)` : "liquid, IV reasonable",
      !liquid ? 4 : expensive ? 9 : 15, 15));
  }
  return { score: scoreFrom(factors), available: true, factors, gaps: factors.filter(x => x.missing).map(x => x.label.toLowerCase()) };
}

export function overallScore(scores) {
  let total = 0;
  let weight = 0;
  for (const key of SCORE_KEYS) {
    if (!isNum(scores[key].score)) continue;
    total += scores[key].score * RULES.weights[key];
    weight += RULES.weights[key];
  }
  return weight ? Math.round(total / weight) : null;
}

/* ------------------------------------------------------------------ diagnostics */

const label = (name, value, tone = "", detail = "") => ({ name, value, tone, detail });

export function diagnose(item, context, scores, levels) {
  const f = item.fundamentals;
  const c = item.catalysts || {};
  const sigma = monthlySigma(item);
  const spy = context.spy;
  const rel3 = item.ticker === "SPY" ? null : relativeToSpy(item, spy, "return3m");
  const rel12 = item.ticker === "SPY" ? null : relativeToSpy(item, spy, "return12m");

  // Market context
  const regimeWord = { BULLISH: ["Bullish", "pos"], NEUTRAL: ["Neutral", "warn"], CAUTIOUS: ["Neutral", "warn"], BEARISH: ["Bearish", "neg"] }[context.regime];
  const sector = context.sectors?.[item.sector];
  const sectorRel = sector ? relativeToSpy(sector, spy, "return3m") : null;
  const breadth = isNum(context.breadthNow) && isNum(context.breadthPrior)
    ? label("Market breadth", context.breadthNow >= context.breadthPrior ? "Expanding" : "Contracting", context.breadthNow >= context.breadthPrior ? "pos" : "neg",
      `${Math.round(context.breadthNow * 100)}% of ${context.trackedStocks} tracked stocks above their 50-day, vs ${Math.round(context.breadthPrior * 100)}% a month ago`)
    : label("Market breadth", "N/A", "", "Needs a month-ago 50-day SMA for most tracked stocks");
  const spyVol = spy?.hv30;
  const market = [
    label("Market regime", regimeWord[0], regimeWord[1], context.regimeDescription),
    isNum(sectorRel)
      ? label("Sector regime", sectorRel >= 0.02 ? "Leading" : sectorRel <= -0.02 ? "Lagging" : "Neutral", sectorRel >= 0.02 ? "pos" : sectorRel <= -0.02 ? "neg" : "warn",
        `${item.sector} (${sector.etf}) ${signed(sectorRel)} vs SPY over 3 months`)
      : label("Sector regime", "N/A", "", item.etf ? "ETF" : "No sector benchmark for this stock"),
    isNum(rel3)
      ? label("Relative strength", rel3 >= 0.05 ? "Strong" : rel3 <= -0.05 ? "Weak" : "Neutral", rel3 >= 0.05 ? "pos" : rel3 <= -0.05 ? "neg" : "warn",
        `${signed(rel3)} vs SPY over 3 months${isNum(rel12) ? `, ${signed(rel12)} over 12 months` : ""}`)
      : label("Relative strength", item.ticker === "SPY" ? "Benchmark" : "N/A"),
    breadth,
    isNum(spyVol)
      ? label("Volatility regime", spyVol < 0.12 ? "Low" : spyVol <= 0.22 ? "Normal" : "Elevated", spyVol < 0.12 ? "pos" : spyVol <= 0.22 ? "" : "neg", `SPY 30-day realized volatility ${pct(spyVol)}`)
      : label("Volatility regime", "N/A")
  ];

  // Asset quality
  const q = scores.quality.score;
  const netRevisions = isNum(c.revisionsUp) && isNum(c.revisionsDown) ? c.revisionsUp - c.revisionsDown : null;
  const lq = f?.latestQuarter;
  let earningsTrend = label("Earnings trend", "N/A");
  if (lq && isNum(lq.netIncome) && isNum(lq.netIncomePriorYear)) {
    const quarterGrowth = lq.netIncomePriorYear > 0 ? lq.netIncome / lq.netIncomePriorYear - 1 : null;
    const ttm = f.earningsGrowthYoY;
    let word = "Stable";
    if (lq.netIncomePriorYear <= 0) word = lq.netIncome > 0 ? "Accelerating" : "Stable";
    else if (lq.netIncome < 0) word = "Decelerating";
    else if (isNum(ttm)) word = quarterGrowth - ttm > 0.10 ? "Accelerating" : quarterGrowth - ttm < -0.10 ? "Decelerating" : "Stable";
    earningsTrend = label("Earnings trend", word, { Accelerating: "pos", Stable: "warn", Decelerating: "neg" }[word],
      `Latest quarter net income ${isNum(quarterGrowth) ? `${signed(quarterGrowth)} YoY` : "turned from a loss"}${isNum(ttm) ? `; trailing twelve months ${signed(ttm)}` : ""}`);
  }
  const valuation = valuationLabel(item);
  const peg = pegLabel(item);
  const quality = item.etf ? [label("Fundamental quality", "N/A (ETF)")] : [
    isNum(q) ? label("Fundamental quality", q >= 80 ? "Excellent" : q >= 65 ? "Strong" : q >= RULES.weakScore ? "Fair" : "Weak",
      q >= 65 ? "pos" : q >= RULES.weakScore ? "warn" : "neg", `Quality score ${q}`) : label("Fundamental quality", "N/A", "", "No recent SEC filing data"),
    earningsTrend,
    isNum(f?.revenueGrowthYoY)
      ? label("Revenue growth", f.revenueGrowthYoY >= 0.20 ? "High" : f.revenueGrowthYoY >= 0.05 ? "Moderate" : "Low", f.revenueGrowthYoY >= 0.20 ? "pos" : f.revenueGrowthYoY >= 0.05 ? "warn" : "neg", `${signed(f.revenueGrowthYoY)} YoY`)
      : label("Revenue growth", "N/A"),
    isNum(f?.operatingMarginChange)
      ? label("Margin quality", f.operatingMarginChange >= 0.01 ? "Expanding" : f.operatingMarginChange <= -0.01 ? "Compressing" : "Stable",
        f.operatingMarginChange >= 0.01 ? "pos" : f.operatingMarginChange <= -0.01 ? "neg" : "warn", `Operating margin ${pct(f.operatingMargin)} (${signed(f.operatingMarginChange)} YoY)`)
      : label("Margin quality", "N/A"),
    valuation
      ? label("Valuation", valuation, { Cheap: "pos", Fair: "warn", Expensive: "neg", Extreme: "neg", Unprofitable: "neg" }[valuation],
        `Forward P/E ${isNum(item.valuation.forwardPe) ? `${item.valuation.forwardPe.toFixed(1)}x` : "N/A"}${isNum(item.valuation.historical5yPe) ? ` vs 5-year average ${item.valuation.historical5yPe.toFixed(1)}x` : ""}`)
      : label("Valuation", "N/A"),
    peg ? label("Valuation vs growth", peg, { Attractive: "pos", Fair: "warn", Stretched: "neg" }[peg], `PEG ${item.valuation.pegRatio.toFixed(2)}`) : label("Valuation vs growth", "N/A"),
    isNum(netRevisions)
      ? label("Analyst revision trend", netRevisions >= 2 ? "Improving" : netRevisions <= -2 ? "Deteriorating" : "Neutral", netRevisions >= 2 ? "pos" : netRevisions <= -2 ? "neg" : "warn",
        `${c.revisionsUp} up / ${c.revisionsDown} down over 4 weeks`)
      : label("Analyst revision trend", "N/A")
  ];

  // Technical state
  const primary = isNum(item.sma50) && isNum(item.sma200)
    ? (item.price > item.sma200 && item.sma50 > item.sma200 ? "Bullish" : item.price < item.sma200 && item.sma50 < item.sma200 ? "Bearish" : "Neutral")
    : null;
  const shortTerm = isNum(item.sma20) && isNum(item.sma50)
    ? (item.price > item.sma20 && item.sma20 > item.sma50 ? "Bullish" : item.price < item.sma20 && item.sma20 < item.sma50 ? "Bearish" : "Neutral")
    : null;
  const trendTone = { Bullish: "pos", Neutral: "warn", Bearish: "neg" };
  let momentum = null;
  if (isNum(item.return1m) && isNum(item.return3m)) {
    const gap = (item.return1m - item.return3m / 3) / sigma;
    momentum = gap > 0.5 ? "Accelerating" : gap < -0.5 ? "Fading" : "Stable";
  }
  const averages = [["20D", item.sma20], ["50D", item.sma50], ["200D", item.sma200]].filter(([, v]) => isNum(v));
  const aboveList = averages.filter(([, v]) => item.price > v).map(([n]) => n);
  const location = !averages.length ? "N/A" : aboveList.length === averages.length ? `Above ${aboveList.join(", ")}`
    : aboveList.length ? `Above ${aboveList.join(", ")} only` : `Below ${averages.map(([n]) => n).join(", ")}`;
  const rangeHigh = isNum(item.rangeHigh60) ? item.rangeHigh60 : item.high52;
  const rangeLow = isNum(item.rangeLow60) ? item.rangeLow60 : item.low52;
  const breakout = !isNum(rangeHigh) ? null
    : item.price > rangeHigh ? "Breakout" : isNum(rangeLow) && item.price < rangeLow ? "Breakdown" : item.price >= rangeHigh * 0.97 ? "Near Breakout" : "Range";
  const pullbackDepth = isNum(rangeHigh) ? Math.max(0, (rangeHigh - item.price) / rangeHigh) / sigma : null;
  const pullback = !isNum(pullbackDepth) ? null : pullbackDepth <= 0.25 ? "None" : pullbackDepth <= 0.75 ? "Shallow" : pullbackDepth <= 1.5 ? "Normal" : "Deep";
  const technical = [
    label("Primary trend", primary ?? "N/A", trendTone[primary] ?? "", "Price and 50-day SMA vs the 200-day SMA"),
    label("Short-term trend", shortTerm ?? "N/A", trendTone[shortTerm] ?? "", "Price vs 20-day SMA vs 50-day SMA"),
    label("Momentum", momentum ?? "N/A", { Accelerating: "pos", Stable: "warn", Fading: "neg" }[momentum] ?? "",
      isNum(item.return1m) && isNum(item.return3m) ? `1-month return ${signed(item.return1m)} vs 3-month pace ${signed(item.return3m / 3)} a month` : ""),
    label("RSI state", !isNum(item.rsi14) ? "N/A" : item.rsi14 < 30 ? "Oversold" : item.rsi14 > 70 ? "Overbought" : "Healthy",
      !isNum(item.rsi14) ? "" : item.rsi14 < 30 ? "warn" : item.rsi14 > 70 ? "neg" : "pos", isNum(item.rsi14) ? `RSI(14) ${item.rsi14.toFixed(1)}` : ""),
    label("Trend location", location, aboveList.includes("200D") && aboveList.includes("50D") ? "pos" : !aboveList.includes("200D") && averages.length ? "neg" : "warn"),
    label("Support distance", isNum(levels.downside) ? `−${pct(levels.downside)}` : "N/A", "",
      `${isNum(levels.entrySupport) ? `Entry support ${usd(levels.entrySupport)} (${levels.entryMethod})` : "No entry support"}${isNum(levels.structural) ? `; structural ${usd(levels.structural)} (−${pct(levels.toStructural)})` : ""}`),
    label("Resistance distance", levels.resistance ? signed(levels.upside) : "Clear", "", levels.resistance ? `Resistance ${usd(levels.resistance)}` : "Price is above all one-year swing highs"),
    label("Breakout status", breakout ?? "N/A", { Breakout: "pos", "Near Breakout": "pos", Range: "warn", Breakdown: "neg" }[breakout] ?? "",
      isNum(rangeHigh) ? `60-session range ${usd(rangeLow)} – ${usd(rangeHigh)}` : ""),
    label("Pullback status", pullback ?? "N/A", { None: "", Shallow: "pos", Normal: "warn", Deep: "neg" }[pullback] ?? "",
      isNum(rangeHigh) ? `${pct(Math.max(0, 1 - item.price / rangeHigh))} below the 60-session high` : "")
  ];

  // Entry diagnostics
  const e = scores.entry.score;
  const rsi = item.rsi14;
  let entryType = "Continuation";
  if (primary === "Bullish" && (breakout === "Breakout" || breakout === "Near Breakout")) entryType = "Breakout";
  else if (primary === "Bullish" && (pullback === "Shallow" || pullback === "Normal") && isNum(levels.downside) && levels.downside / sigma <= 0.5) entryType = "Pullback";
  else if (primary !== "Bullish" && shortTerm === "Bullish") entryType = "Reversal";
  else if ((isNum(rsi) && rsi < 30) || (primary !== "Bullish" && pullback === "Deep")) entryType = "Mean Reversion";
  else if (primary === "Bullish" && (pullback === "Shallow" || pullback === "Normal")) entryType = "Pullback";

  const dist50 = isNum(item.sma50) ? (item.price - item.sma50) / item.sma50 : null;
  const dist200 = isNum(item.sma200) ? (item.price - item.sma200) / item.sma200 : null;
  const farFromIdeal = isNum(levels.distanceFromIdeal) ? levels.distanceFromIdeal / sigma : 0;
  const chase = farFromIdeal > 1 || (isNum(dist50) && dist50 / sigma > 1.5) || (isNum(rsi) && rsi > 75) ? "High"
    : farFromIdeal > 0.4 || (isNum(rsi) && rsi > 68) || (isNum(dist200) && dist200 > 0.35) ? "Moderate" : "Low";

  let trigger;
  if (entryType === "Breakout" || entryType === "Continuation") {
    trigger = levels.resistance ? `Break & hold > ${usd(levels.resistance)}` : isNum(levels.zoneHigh) ? `Pullback into ${usd(levels.zoneLow)}–${usd(levels.zoneHigh)}` : "N/A";
  } else if (entryType === "Pullback") {
    trigger = isNum(levels.entrySupport) ? `Hold ${usd(levels.entrySupport)} on a retest` : "N/A";
  } else if (entryType === "Reversal") {
    trigger = isNum(item.sma200) && item.price < item.sma200 ? `Reclaim & hold > 200D (${usd(item.sma200)})` : isNum(item.sma50) ? `Hold > 50D (${usd(item.sma50)})` : "N/A";
  } else {
    trigger = isNum(item.sma20) ? `Close back above 20D (${usd(item.sma20)})` : "N/A";
  }

  const entry = [
    label("Entry quality", !isNum(e) ? "N/A" : e >= 80 ? "Excellent" : e >= 65 ? "Good" : e >= RULES.weakScore ? "Neutral" : "Poor",
      !isNum(e) ? "" : e >= 65 ? "pos" : e >= RULES.weakScore ? "warn" : "neg", `Entry score ${e}`),
    label("Entry type", entryType),
    label("Risk/reward", isNum(levels.rewardRisk) ? `${levels.rewardRisk.toFixed(1)} : 1` : "N/A",
      !isNum(levels.rewardRisk) ? "" : levels.rewardRisk >= 2 ? "pos" : levels.rewardRisk >= 1 ? "warn" : "neg", `Target: ${levels.targetSource} ${usd(levels.target)}`),
    label("Upside to resistance", levels.resistance ? signed(levels.upside) : "Clear", "", levels.resistance ? usd(levels.resistance) : `Target uses the ${levels.targetSource}`),
    label("Downside to support", isNum(levels.downside) ? `−${pct(levels.downside)}` : "N/A", "", isNum(levels.entrySupport) ? `${usd(levels.entrySupport)} (${levels.entryMethod})` : ""),
    label("Distance from ideal entry", isNum(levels.distanceFromIdeal) ? (levels.distanceFromIdeal === 0 ? "In zone" : signed(levels.distanceFromIdeal)) : "N/A",
      !isNum(levels.distanceFromIdeal) ? "" : levels.distanceFromIdeal === 0 ? "pos" : farFromIdeal > 1 ? "neg" : "warn",
      isNum(levels.distanceFromIdeal) ? `${(farFromIdeal).toFixed(2)} monthly moves above the preferred entry` : ""),
    label("Chase risk", chase, { Low: "pos", Moderate: "warn", High: "neg" }[chase]),
    label("Invalidation level", isNum(levels.entrySupport) ? usd(levels.entrySupport) : "N/A", "",
      isNum(levels.entrySupport) ? `Daily close below entry support${isNum(levels.structural) && levels.structural !== levels.entrySupport ? `; structural support ${usd(levels.structural)}` : ""}` : ""),
    label("Trigger", trigger),
    label("Preferred entry", isNum(levels.zoneLow) ? `${usd(levels.zoneLow)}–${usd(levels.zoneHigh)}` : "N/A")
  ];

  return { market, quality, technical, entry, entryType, chase, trigger, primaryTrend: primary };
}

/* ------------------------------------------------------------------ flags, bear case, options */

function flagsFor(item, levels) {
  const flags = [];
  const warnings = [];
  const warn = (text) => { flags.push(text); warnings.push(text); };
  const f = item.fundamentals;
  const c = item.catalysts || {};
  const v = item.valuation || {};

  if (isNum(item.sma200) && item.price < item.sma200) warn("Below 200d SMA (long-term downtrend)");
  const dist50 = isNum(item.sma50) ? (item.price - item.sma50) / item.sma50 : null;
  const dist200 = isNum(item.sma200) ? (item.price - item.sma200) / item.sma200 : null;
  if (isNum(dist50) && dist50 > RULES.extendedAbove50) warn(`Price extended ${pct(dist50)} above 50d SMA`);
  else if (isNum(dist200) && dist200 > RULES.extendedAbove200) warn(`Price extended ${pct(dist200)} above 200d SMA`);
  if (isNum(item.rsi14) && item.rsi14 > 70) warn(`RSI ${item.rsi14.toFixed(1)} overbought`);
  if (isNum(item.rsi14) && item.rsi14 < 30) flags.push(`RSI ${item.rsi14.toFixed(1)} oversold`);
  if (isNum(levels.entrySupport) && isNum(levels.downside) && levels.downside <= monthlySigma(item) * 0.5) flags.push(`Near entry support ${usd(levels.entrySupport)}`);
  if (earningsInWindow(item)) warn(`Earnings in ${c.daysToEarnings} days (${c.nextEarningsDate}${c.earningsDateEstimated ? ", estimated" : ""}): binary gap risk`);
  if (isNum(c.revisionsUp) && isNum(c.revisionsDown)) {
    const net = c.revisionsUp - c.revisionsDown;
    if (net >= 2) flags.push(`${net} net upward EPS estimate revisions (4 weeks)`);
    else if (net <= -2) warn(`${-net} net downward EPS estimate revisions (4 weeks)`);
  }
  if (isNum(c.oneYearTarget) && c.oneYearTarget / item.price - 1 < -0.05) warn(`Price above analyst 1y target ($${c.oneYearTarget.toFixed(2)})`);
  if (f) {
    if (isNum(f.revenueGrowthYoY) && f.revenueGrowthYoY < 0) warn(`Revenue shrinking ${pct(f.revenueGrowthYoY)} YoY`);
    if (isNum(f.operatingMargin) && f.operatingMargin < 0.08) warn(`Thin operating margin ${pct(f.operatingMargin)}`);
    if (isNum(f.netDebtToEbitda) && f.netDebtToEbitda > 2.5 && !/financ/i.test(item.sector || "")) warn(`High leverage ${f.netDebtToEbitda.toFixed(1)}x net debt/EBITDA`);
    if (isNum(f.freeCashFlow) && f.freeCashFlow < 0) warn("Negative free cash flow");
    if (f.direction === "getting_weaker") warn("Business getting weaker (growth, margins or earnings falling)");
    if (f.direction === "getting_stronger") flags.push("Business getting stronger");
  }
  const pe = isNum(v.forwardPe) ? v.forwardPe : v.trailingPe;
  if (isNum(pe) && pe > RULES.extremePe) warn(`P/E ${pe.toFixed(1)}x is above ${RULES.extremePe}x`);
  if (isNum(v.pegRatio) && v.pegRatio > 2.5) warn(`PEG ${v.pegRatio.toFixed(2)}`);
  return { flags, warnings };
}

export function evaluateOptions(item, readyToAct, earningsWarning) {
  const o = item.options;
  if (!o || !isNum(o.atmCallAsk) || o.atmCallAsk <= 0) {
    return { recommendation: readyToAct ? "SHARES" : "WAIT", reason: "No listed options data for a 21-120 DTE expiration.", tradeSpecs: null };
  }

  const spreadPct = ((o.atmCallAsk - o.atmCallBid) / o.atmCallAsk) * 100;
  const isLiquid = o.atmCallOpenInterest >= RULES.minOpenInterest && spreadPct <= RULES.maxSpreadPct;
  const ratio = o.ivHvRatio;
  const ivText = isNum(ratio) ? `ATM IV ${pct(o.impliedVolatility)} is ${ratio.toFixed(2)}x 30-day realized volatility` : "IV vs realized volatility unavailable";

  if (earningsWarning) {
    return { recommendation: "SHARES ONLY (OR WAIT)", reason: `Earnings in ${item.catalysts.daysToEarnings} days; long options would absorb the post-earnings IV crush.`, spreadPct, isLiquid, tradeSpecs: null };
  }
  if (!readyToAct) {
    return { recommendation: "WAIT", reason: "Not in the buy zone yet. Plan the trade at the preferred entry instead of chasing.", spreadPct, isLiquid, tradeSpecs: null };
  }
  if (!isLiquid) {
    return { recommendation: "SHARES", reason: `Options are illiquid (OI ${o.atmCallOpenInterest}, spread ${spreadPct.toFixed(1)}%). Trade shares to limit slippage.`, spreadPct, isLiquid, tradeSpecs: null };
  }
  if (isNum(ratio) && ratio >= RULES.ivExpensiveRatio) {
    return { recommendation: "CASH-SECURED PUT OR SHARES", reason: `${ivText}: options are expensive. Sell a put near support or buy shares.`, spreadPct, isLiquid, tradeSpecs: null };
  }
  if (isNum(ratio) && ratio <= RULES.ivCheapRatio) {
    return { recommendation: "LONG CALL OR CALL DEBIT SPREAD", reason: `${ivText}: options are cheap relative to recent movement.`, spreadPct, isLiquid, tradeSpecs: null };
  }
  return { recommendation: "CALL DEBIT SPREAD", reason: `${ivText}: a vertical spread offsets theta decay.`, spreadPct, isLiquid, tradeSpecs: null };
}

export function synthesizeBearCase(item, levels, context, warnings) {
  const risks = [];
  const extension = warnings.find(w => w.startsWith("Price extended"));
  if (extension) risks.push(`mean reversion (${extension.replace(/^Price/, "price")})`);
  const valuation = valuationLabel(item);
  if (valuation === "Expensive" || valuation === "Extreme") risks.push(`multiple compression (${valuation.toLowerCase()} valuation)`);
  if (item.fundamentals?.direction === "getting_weaker") risks.push("deteriorating fundamentals (growth, margins or earnings falling)");
  if (earningsInWindow(item)) risks.push("an earnings-driven gap within two weeks");
  if (isNum(item.sma200) && item.price < item.sma200) risks.push("an established long-term downtrend below the 200d SMA");
  if (context.regime === "BEARISH" || context.regime === "CAUTIOUS") risks.push(`a ${context.regime.toLowerCase()} broad market`);
  if (!risks.length) risks.push("a broad market pullback dragging the stock back to support");

  const trade = isNum(levels.entrySupport) ? `Trade: a daily close below entry support ${usd(levels.entrySupport)} (${levels.entryMethod}).` : "Trade: no entry support below price.";
  const thesis = isNum(levels.structural) ? ` Thesis: a daily close below structural support ${usd(levels.structural)}.` : "";
  return { bearCase: `Main risks: ${risks.join("; ")}.`, invalidationLevel: `${trade}${thesis}` };
}

/* ------------------------------------------------------------------ evaluation */

/**
 * Verdict from the four scores. Buy zone needs every score to clear its bar, reward/risk of at least 1.5 : 1, chase risk
 * below High and no earnings inside 14 days. A strong asset that misses says which part is missing; avoid says whether the trend or the business is the problem.
 */
export function classify(scores, earningsWarning, chaseRisk, rewardRisk) {
  const q = scores.quality.score;
  const t = scores.trend.score;
  const e = scores.entry.score;
  const tr = scores.trade.score;
  const { buyZone, strongAsset, avoid } = RULES;
  if (isNum(q) && q < avoid.quality) return { bucket: "avoid", verdict: VERDICT_LABELS.avoidQuality };
  if (t < avoid.trend) return { bucket: "avoid", verdict: VERDICT_LABELS.avoidTrend };

  const entryOk = e >= buyZone.entry && chaseRisk !== "High";
  const tradeOk = tr >= buyZone.trade && isNum(rewardRisk) && rewardRisk >= buyZone.rewardRisk;
  if (entryOk && tradeOk && t >= buyZone.trend && (!isNum(q) || q >= buyZone.quality) && !earningsWarning) {
    return { bucket: "buy", verdict: VERDICT_LABELS.buy };
  }
  const strong = (isNum(q) ? q >= strongAsset.quality : t >= strongAsset.etfTrend) && t >= strongAsset.trend;
  if (!strong) return { bucket: "watch", verdict: VERDICT_LABELS.watch };
  const verdict = !entryOk ? VERDICT_LABELS.strongEntry : !tradeOk ? VERDICT_LABELS.strongTrade : earningsWarning ? VERDICT_LABELS.strongEarnings : VERDICT_LABELS.strongEntry;
  return { bucket: "strong", verdict };
}

/**
 * @param {object} item a data/market.json stock record
 * @param {ReturnType<typeof buildMarketContext>} context
 * @returns evaluation with scores (quality/trend/entry/trade, each with factors), overall, levels, diagnostics,
 *   bucket (buy | strong | watch | avoid), verdict label, warnings, flags, dataGaps, optionsEval and bear case
 */
export function evaluateAsset(item, context) {
  const levels = computeLevels(item);
  const scores = {
    quality: scoreQuality(item),
    trend: scoreTrend(item, context),
    entry: scoreEntry(item, levels),
    trade: scoreTrade(item, levels)
  };
  const overall = overallScore(scores);
  const earningsWarning = earningsInWindow(item);
  const { flags, warnings } = flagsFor(item, levels);

  const diagnostics = diagnose(item, context, scores, levels);
  const { bucket, verdict } = classify(scores, earningsWarning, diagnostics.chase, levels.rewardRisk);

  const dataGaps = [...SCORE_KEYS.flatMap(k => scores[k].gaps), ...(item.options ? [] : ["options chain"])];
  const optionsEval = evaluateOptions(item, bucket === "buy", earningsWarning);
  if (optionsEval.isLiquid === false) {
    warnings.push(`Illiquid options (OI ${item.options.atmCallOpenInterest}, spread ${optionsEval.spreadPct.toFixed(1)}%)`);
  }
  return {
    item, scores, overall, levels, bucket, verdict, earningsWarning, flags, warnings, dataGaps, optionsEval, diagnostics,
    bearCase: synthesizeBearCase(item, levels, context, warnings)
  };
}

const BUCKET_ORDER = { buy: 0, strong: 1, watch: 2, avoid: 3 };

/**
 * Sorts by bucket then Overall and groups evaluations. `best` is the buy-zone stock with the highest Overall,
 * or null (the honest default is WAIT).
 */
export function classifyEvaluations(evaluations) {
  const sorted = [...evaluations].sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.overall - a.overall || a.item.ticker.localeCompare(b.item.ticker));
  const buckets = { buy: [], strong: [], watch: [], avoid: [] };
  for (const e of sorted) buckets[e.bucket].push(e);
  return { sorted, best: buckets.buy[0] ?? null, ...buckets };
}

/** Returns modified copies for stress tests; SMAs and levels stay put so the shock is measured against them. */
export function applyScenario(records, scenario) {
  // Records are plain JSON; a JSON round-trip avoids structuredClone, which older mobile browsers lack.
  const copies = JSON.parse(JSON.stringify(records));
  for (const r of copies) {
    if (scenario === "pullback" && (/technology/i.test(r.sector || "") || r.ticker === "QQQ")) {
      r.price = Math.round(r.price * 0.92 * 100) / 100;
      if (isNum(r.rsi14)) r.rsi14 = Math.max(28, r.rsi14 - 14);
    } else if (scenario === "high_iv" && r.options && isNum(r.options.ivHvRatio)) {
      r.options.impliedVolatility *= 1.6;
      r.options.ivHvRatio = Math.round(r.options.ivHvRatio * 1.6 * 100) / 100;
    } else if (scenario === "overbought") {
      r.price = Math.round(r.price * 1.08 * 100) / 100;
      if (isNum(r.rsi14)) r.rsi14 = Math.min(84, r.rsi14 + 18);
    }
  }
  return copies;
}
