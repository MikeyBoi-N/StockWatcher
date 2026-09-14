/**
 * StockWatcher deterministic scoring engine.
 *
 * Pure functions over stock records from data/market.json (built by scripts/build_market_data.py).
 * Any field may be null (ETFs have no fundamentals, new listings lack a 200-day history, some names have
 * no listed options); a missing input scores the pillar's neutral midpoint and is reported in `dataGaps`.
 *
 * Opportunity Score (0-100) = Technicals (0-30) + Fundamentals (0-25) + Valuation (0-20)
 *                            + Catalysts (0-15) + Market Regime (0-10) - extension/earnings penalties.
 */

export const RULES = {
  extendedAbove50: 0.12,
  extendedAbove200: 0.22,
  nearSupportPct: 0.035,
  earningsWarningDays: 14,
  richPe: 40,
  extremePe: 60,
  ivExpensiveRatio: 1.3,
  ivCheapRatio: 0.9,
  minOpenInterest: 500,
  maxSpreadPct: 6,
  actionableScore: 70,
  bestScore: 75,
  avoidScore: 55
};

const REGIME_BONUS = { BULLISH: 9, NEUTRAL: 6, CAUTIOUS: 3, BEARISH: 0 };

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

export function evaluateTechnicals(item) {
  let score = 15;
  const flags = [];
  const warnings = [];
  const warn = (text) => { flags.push(text); warnings.push(text); };
  const gaps = [];
  const drawdownPct = isNum(item.high52) && item.high52 > 0 ? ((item.high52 - item.price) / item.high52) * 100 : 0;

  if (isNum(item.sma200)) {
    if (item.price > item.sma200) score += 4;
    else { score -= 6; warn("Below 200d SMA (long-term downtrend)"); }
  } else {
    gaps.push("200-day SMA (under 200 days of trading history)");
  }

  const dist50 = isNum(item.sma50) ? (item.price - item.sma50) / item.sma50 : null;
  const dist200 = isNum(item.sma200) ? (item.price - item.sma200) / item.sma200 : null;
  const isExtended = (dist50 !== null && dist50 > RULES.extendedAbove50) || (dist200 !== null && dist200 > RULES.extendedAbove200);
  if (isExtended) {
    score -= 8;
    warn(dist50 !== null && dist50 > RULES.extendedAbove50
      ? `Price extended ${pct(dist50)} above 50d SMA`
      : `Price extended ${pct(dist200)} above 200d SMA`);
  }

  const nearSupport = isNum(item.majorSupport)
    && Math.abs(item.price - item.majorSupport) / item.price <= RULES.nearSupportPct
    && item.price >= item.majorSupport * 0.985;
  if (nearSupport) {
    score += 7;
    flags.push(`Within ${pct(RULES.nearSupportPct)} of support $${item.majorSupport.toFixed(2)}`);
  }

  if (isNum(item.rsi14)) {
    const above200 = isNum(item.sma200) && item.price > item.sma200;
    if (item.rsi14 < 38) {
      if (nearSupport && above200) { score += 3; flags.push(`RSI ${item.rsi14.toFixed(1)} oversold at support`); }
      else { score -= 2; warn(`RSI ${item.rsi14.toFixed(1)} weak without support`); }
    } else if (item.rsi14 > 68) {
      score -= 5;
      warn(`RSI ${item.rsi14.toFixed(1)} overbought`);
    }
  } else {
    gaps.push("RSI");
  }

  return { score: clamp(Math.round(score), 0, 30), flags, warnings, gaps, isExtended, nearSupport, drawdownPct, dist50, dist200 };
}

export function evaluateFundamentals(item) {
  const f = item.fundamentals;
  if (!f) {
    return {
      score: 12, available: false, flags: [], warnings: [],
      assessment: item.etf ? "N/A (ETF)" : "N/A (no recent SEC filing data)",
      gaps: item.etf ? [] : ["SEC fundamentals"]
    };
  }

  let score = 12;
  const flags = [];
  if (isNum(f.revenueGrowthYoY)) {
    if (f.revenueGrowthYoY >= 0.20) score += 5;
    else if (f.revenueGrowthYoY >= 0.10) score += 3;
    else if (f.revenueGrowthYoY < 0) { score -= 4; flags.push(`Revenue shrinking ${pct(f.revenueGrowthYoY)} YoY`); }
  }
  if (isNum(f.operatingMargin)) {
    if (f.operatingMargin >= 0.30) score += 4;
    else if (f.operatingMargin < 0.08) { score -= 3; flags.push(`Thin operating margin ${pct(f.operatingMargin)}`); }
  }
  // Leverage ratios aren't meaningful for banks and insurers (deposits and float are funding, not debt).
  const financial = /financ/i.test(item.sector || "");
  if (isNum(f.netDebtToEbitda) && !financial) {
    if (f.netDebtToEbitda <= 0.5) score += 3;
    else if (f.netDebtToEbitda > 2.5) { score -= 4; flags.push(`High leverage ${f.netDebtToEbitda.toFixed(1)}x net debt/EBITDA`); }
  }
  if (isNum(f.freeCashFlow) && f.freeCashFlow < 0) { score -= 2; flags.push("Negative free cash flow"); }

  let assessment = "Roughly Unchanged";
  if (f.direction === "getting_stronger") { score += 3; assessment = "Getting Stronger"; }
  else if (f.direction === "getting_weaker") { score -= 5; assessment = "Getting Weaker"; }

  return { score: clamp(Math.round(score), 0, 25), available: true, assessment, flags, warnings: flags, gaps: [] };
}

export function evaluateValuation(item) {
  const v = item.valuation || {};
  let score = 10;
  const flags = [];
  const currentPe = isNum(v.forwardPe) ? v.forwardPe : v.trailingPe;
  let status = "unknown";

  if (isNum(currentPe) && currentPe > RULES.extremePe) {
    // A rich multiple can't become "cheap" just because its own history was even richer.
    score -= 4;
    status = "stretched";
    flags.push(`P/E ${currentPe.toFixed(1)}x is above ${RULES.extremePe}x`);
  } else if (isNum(currentPe) && isNum(v.historical5yPe) && v.historical5yPe >= 5 && v.historical5yPe <= RULES.extremePe) {
    const discount = (v.historical5yPe - currentPe) / v.historical5yPe;
    if (discount >= 0.15 && currentPe <= RULES.richPe) { score += 4; status = "attractive"; }
    else if (discount <= -0.25) { score -= 4; status = "stretched"; flags.push(`P/E ${currentPe.toFixed(1)}x vs 5y avg ${v.historical5yPe.toFixed(1)}x`); }
    else status = "fair";
  }
  if (isNum(v.pegRatio)) {
    if (v.pegRatio <= 1.2) score += 4;
    else if (v.pegRatio > 2.5) { score -= 5; flags.push(`PEG ${v.pegRatio.toFixed(2)}`); }
    else if (v.pegRatio > 2.0) score -= 2;
  }
  if (isNum(v.fcfYield)) {
    if (v.fcfYield >= 0.05) score += 3;
    else if (v.fcfYield < 0.02) score -= 2;
  }

  const available = [currentPe, v.pegRatio, v.fcfYield].some(isNum);
  if (status === "unknown" && available) status = score > 12 ? "attractive" : score < 8 ? "stretched" : "fair";
  return {
    score: clamp(Math.round(score), 0, 20), available, assessment: available ? status : (item.etf ? "N/A (ETF)" : "N/A"),
    flags, warnings: flags, gaps: available || item.etf ? [] : ["valuation multiples"]
  };
}

export function evaluateCatalysts(item) {
  const c = item.catalysts || {};
  let score = 8;
  const flags = [];
  const warnings = [];
  const warn = (text) => { flags.push(text); warnings.push(text); };
  let earningsWarning = false;

  if (isNum(c.daysToEarnings) && c.daysToEarnings <= RULES.earningsWarningDays) {
    score -= 4;
    earningsWarning = true;
    warn(`Earnings in ${c.daysToEarnings} days (${c.nextEarningsDate}${c.earningsDateEstimated ? ", estimated" : ""}): binary gap risk`);
  }
  if (isNum(c.revisionsUp) && isNum(c.revisionsDown)) {
    const net = c.revisionsUp - c.revisionsDown;
    if (net >= 2) { score += 3; flags.push(`${net} net upward EPS estimate revisions (4 weeks)`); }
    else if (net <= -2) { score -= 3; warn(`${-net} net downward EPS estimate revisions (4 weeks)`); }
  }
  if (isNum(c.oneYearTarget) && item.price > 0) {
    const upside = c.oneYearTarget / item.price - 1;
    if (upside > 0.15) score += 2;
    else if (upside < -0.05) { score -= 2; warn(`Price above analyst 1y target ($${c.oneYearTarget.toFixed(2)})`); }
  }

  return { score: clamp(Math.round(score), 0, 15), flags, warnings, earningsWarning };
}

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

export function evaluateOptions(item, totalScore, earningsWarning) {
  const o = item.options;
  if (!o || !isNum(o.atmCallAsk) || o.atmCallAsk <= 0) {
    return { recommendation: totalScore < RULES.actionableScore ? "WAIT" : "SHARES", reason: "No listed options data for a 21-120 DTE expiration.", tradeSpecs: null };
  }

  const spreadPct = ((o.atmCallAsk - o.atmCallBid) / o.atmCallAsk) * 100;
  const isLiquid = o.atmCallOpenInterest >= RULES.minOpenInterest && spreadPct <= RULES.maxSpreadPct;
  const ratio = o.ivHvRatio;
  const ivText = isNum(ratio) ? `ATM IV ${pct(o.impliedVolatility)} is ${ratio.toFixed(2)}x 30-day realized volatility` : "IV vs realized volatility unavailable";

  if (totalScore < RULES.actionableScore) {
    return { recommendation: "WAIT", reason: "Risk/reward is not attractive today. Capital preservation is priority #1.", spreadPct, isLiquid, tradeSpecs: null };
  }
  if (earningsWarning) {
    return { recommendation: "SHARES ONLY (OR WAIT)", reason: `Earnings in ${item.catalysts.daysToEarnings} days; long options would absorb the post-earnings IV crush.`, spreadPct, isLiquid, tradeSpecs: null };
  }
  if (!isLiquid) {
    return { recommendation: "SHARES", reason: `Options are illiquid (OI ${o.atmCallOpenInterest}, spread ${spreadPct.toFixed(1)}%). Trade shares to limit slippage.`, spreadPct, isLiquid, tradeSpecs: null };
  }
  if (isNum(ratio) && ratio >= RULES.ivExpensiveRatio) {
    return {
      recommendation: "CASH-SECURED PUT OR SHARES", reason: `${ivText}: options are expensive. Sell a put near support $${item.majorSupport.toFixed(2)} or buy shares.`,
      spreadPct, isLiquid, tradeSpecs: { strategy: "Cash-Secured Put", strike: item.majorSupport, dte: o.daysToExpiration, targetDelta: -0.30 }
    };
  }
  if (isNum(ratio) && ratio <= RULES.ivCheapRatio) {
    return {
      recommendation: "LONG CALL OR CALL DEBIT SPREAD", reason: `${ivText}: options are cheap relative to recent movement.`,
      spreadPct, isLiquid, tradeSpecs: { strategy: "Long Call", strike: o.atmCallStrike, dte: o.daysToExpiration, delta: o.atmCallDelta, theta: o.atmCallTheta, breakeven: o.atmCallStrike + o.atmCallAsk }
    };
  }
  return {
    recommendation: "CALL DEBIT SPREAD", reason: `${ivText}: a vertical spread offsets theta decay.`,
    spreadPct, isLiquid, tradeSpecs: { strategy: "Vertical Call Debit Spread", longStrike: o.atmCallStrike, shortStrike: Math.round(o.atmCallStrike * 1.06), dte: o.daysToExpiration }
  };
}

export function synthesizeBearCase(item, tech, fund, val, cat, regime) {
  const risks = [];
  if (tech.isExtended) risks.push(`mean reversion: ${tech.flags.find(f => f.startsWith("Price extended"))}`);
  if (val.assessment === "stretched") risks.push(`multiple compression (${val.flags[0] || "valuation above its norms"})`);
  if (fund.available && fund.assessment === "Getting Weaker") risks.push("deteriorating fundamentals (growth, margins or earnings falling)");
  if (cat.earningsWarning) risks.push("an earnings-driven gap within two weeks");
  if (isNum(item.sma200) && item.price < item.sma200) risks.push("an established long-term downtrend below the 200d SMA");
  if (regime === "BEARISH" || regime === "CAUTIOUS") risks.push(`a ${regime.toLowerCase()} broad market`);
  if (!risks.length) risks.push("a broad market pullback dragging the stock back to support");

  const secondary = isNum(item.secondarySupport) ? ` Next support: $${item.secondarySupport.toFixed(2)}.` : "";
  return {
    bearCase: `Main risks: ${risks.join("; ")}.`,
    invalidationLevel: `A daily close below support at $${item.majorSupport.toFixed(2)}.${secondary}`
  };
}

export function scoreTier(score) {
  if (score >= 90) return "Exceptional Setup (Rare)";
  if (score >= 80) return "Strong Opportunity";
  if (score >= RULES.actionableScore) return "Interesting; Watch Closely";
  if (score < RULES.avoidScore) return "Not Attractive / Avoid";
  return "Neutral / Wait";
}

export function evaluateAsset(item, marketRegime) {
  const tech = evaluateTechnicals(item);
  const fund = evaluateFundamentals(item);
  const val = evaluateValuation(item);
  const cat = evaluateCatalysts(item);
  const marketBonus = REGIME_BONUS[marketRegime] ?? REGIME_BONUS.NEUTRAL;

  let totalScore = tech.score + fund.score + val.score + cat.score + marketBonus;
  if (tech.isExtended) totalScore -= 12;
  if (cat.earningsWarning) totalScore -= 8;
  totalScore = clamp(Math.round(totalScore), 0, 100);

  const dataGaps = [...tech.gaps, ...fund.gaps, ...val.gaps, ...(item.options ? [] : ["options chain"])];
  const optionsEval = evaluateOptions(item, totalScore, cat.earningsWarning);
  const warnings = [...tech.warnings, ...fund.warnings, ...val.warnings, ...cat.warnings];
  if (optionsEval.isLiquid === false) {
    warnings.push(`Illiquid options (OI ${item.options.atmCallOpenInterest}, spread ${optionsEval.spreadPct.toFixed(1)}%)`);
  }
  return {
    item, totalScore, tierLabel: scoreTier(totalScore), marketBonus,
    tech, fund, val, cat, dataGaps, warnings, optionsEval,
    bearCase: synthesizeBearCase(item, tech, fund, val, cat, marketRegime)
  };
}

/**
 * Sorts by score and assigns every evaluation to exactly one bucket:
 *   avoid      - score below 55, or technically extended
 *   actionable - score 70+, trading at major support, and no earnings inside 14 days
 *   notReady   - everything else (quality alone isn't an entry; wait for the support test)
 * `best` is the top actionable evaluation scoring 75+, or null (the honest default is WAIT).
 */
export function classifyEvaluations(evaluations) {
  const sorted = [...evaluations].sort((a, b) => b.totalScore - a.totalScore || a.item.ticker.localeCompare(b.item.ticker));
  const buckets = { actionable: [], notReady: [], avoid: [] };
  for (const e of sorted) {
    if (e.totalScore < RULES.avoidScore || e.tech.isExtended) e.bucket = "avoid";
    else if (e.totalScore >= RULES.actionableScore && e.tech.nearSupport && !e.cat.earningsWarning) e.bucket = "actionable";
    else e.bucket = "notReady";
    buckets[e.bucket].push(e);
  }
  const best = buckets.actionable.find(e => e.totalScore >= RULES.bestScore) || null;
  return { sorted, best, ...buckets };
}

/** Returns modified copies for stress tests; SMAs and levels stay put so the shock is measured against them. */
export function applyScenario(records, scenario) {
  const copies = structuredClone(records);
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
