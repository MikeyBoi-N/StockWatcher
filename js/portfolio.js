/**
 * Portfolio plan: one diversified plan for an account, instead of one all-in trade per stock.
 *
 * The app has no proven edge in picking stocks (see the paper record), and diversification is the one benefit with
 * solid evidence behind it: it cuts risk without lowering expected return. So the plan is a broad index core plus
 * small, capped stock positions, with the risk preference (the share in stocks) setting how much goes to each:
 *   1. Core: the index ETF (SPY), lump sum.
 *   2. Stocks: Buy-zone names first, then Strong ones, each group ordered by the paper record's frozen signal model
 *      (js/edge.js). Watch and Avoid are left out.
 *   3. Weights by risk: inverse forecast volatility, so a volatile stock gets fewer dollars than a calm one; then capped
 *      per stock and per sector. Whatever the caps or share prices can't place goes back to the core.
 *   4. A method per holding, from a catalog (METHODS): lump sum, limit at the preferred entry, a DCA schedule, a
 *      cash-secured put, and a covered-call overlay. Each method says when it applies, so more can be added.
 *   5. Portfolio risk from a single-index model: each holding's beta and stock-specific volatility give the plan's
 *      volatility, beta and diversification ratio, next to putting everything in the index.
 */
import { RULES, optionsPricing } from "./engine.js";
import { blackScholes, maxEntryPrice, strikeStep } from "./strategy.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Named points on the risk slider: the share of the account in stocks. */
export const STYLE_PRESETS = [
  { key: "conservative", label: "Conservative", stocksShare: 0.2 },
  { key: "balanced", label: "Balanced", stocksShare: 0.4 },
  { key: "active", label: "Active", stocksShare: 0.7 }
];
export const MAX_STOCKS_SHARE = 0.9;

/**
 * Everything the risk preference sets, from the share of the account in stocks (0 to 0.9). The caps grow with it so a
 * bigger stock share spreads across more names rather than piling into a few. Between these anchors (share → most
 * names, cap per stock) the values are interpolated, so the presets keep their exact numbers: 5% → 3, 3%; 20% → 5,
 * 5%; 40% → 8, 8%; 70% → 12, 12%; 90% → 15, 15%. Each sector is held to twice the per-stock cap.
 */
const STYLE_ANCHORS = [[0.05, 3, 0.03], [0.2, 5, 0.05], [0.4, 8, 0.08], [0.7, 12, 0.12], [0.9, 15, 0.15]];
export function styleFor(stocksShare) {
  const share = clamp(stocksShare, 0, MAX_STOCKS_SHARE);
  const k = STYLE_ANCHORS.findIndex(a => share <= a[0]);
  const [a, b] = k <= 0 ? [STYLE_ANCHORS[0], STYLE_ANCHORS[0]] : [STYLE_ANCHORS[k - 1], STYLE_ANCHORS[k]];
  const t = b[0] > a[0] ? (share - a[0]) / (b[0] - a[0]) : 0;
  const maxWeight = a[2] + t * (b[2] - a[2]);
  const named = [...STYLE_PRESETS].reverse().find(x => share >= x.stocksShare - 1e-9);
  return {
    stocksShare: share, core: 1 - share,
    maxNames: share > 0 ? Math.round(a[1] + t * (b[1] - a[1])) : 0,
    maxWeight, sectorCap: 2 * maxWeight,
    label: share === 0 ? "All index" : named ? named.label : "Cautious"
  };
}
export const PORTFOLIO_UNIVERSES = [
  { key: "all", label: "All tracked" },
  { key: "tracked", label: "Without screened picks" },
  { key: "primary", label: "Primary list" }
];
export const PORTFOLIO_FIELDS = {
  account: { min: 1, max: 1e9, default: 1000 },
  horizonDays: { min: 7, max: 120, default: 30 }
};
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
const MAX_EXCLUDED = 200;
const CORE_TICKERS = ["SPY"];

/**
 * How often a limit order at the top of the preferred entry zone filled within a month, by how far above the zone the
 * price was when it was placed. Measured on the replay: 12,000 stock-weeks of strong/watch readings, 2021-2026.
 */
const FILL_ODDS = [[0.03, 0.77], [0.07, 0.5], [0.15, 0.21], [Infinity, 0.03]];
/** Strong names closer than this to their entry zone get a limit order; further away, a DCA schedule. */
const LIMIT_GAP = 0.03;
const SHARE_STEP = 0.0001;
const MIN_ORDER = 1;
const SHARE_COST_PER_SIDE = 0.0005;
const DAY_MS = 864e5;

/** Fills missing or invalid settings with defaults and clamps the rest. */
export function normalizePortfolioPrefs(raw) {
  const prefs = {};
  for (const [key, f] of Object.entries(PORTFOLIO_FIELDS)) {
    const v = Number(raw?.[key]);
    prefs[key] = Number.isFinite(v) ? clamp(v, f.min, f.max) : f.default;
  }
  prefs.horizonDays = Math.round(prefs.horizonDays);
  // The share in stocks, on the slider's 5% steps. Older saved settings named a preset instead.
  const share = Number(raw?.stocksShare);
  const preset = STYLE_PRESETS.find(x => x.key === raw?.style);
  prefs.stocksShare = Number.isFinite(share) ? Math.round(clamp(share, 0, MAX_STOCKS_SHARE) * 20) / 20 : preset?.stocksShare ?? 0.4;
  // Tickers the user never wants picked: uppercase, unique, well-formed.
  const excluded = Array.isArray(raw?.excluded) ? raw.excluded.map(t => String(t).trim().toUpperCase()).filter(t => TICKER.test(t)) : [];
  prefs.excluded = [...new Set(excluded)].slice(0, MAX_EXCLUDED);
  prefs.universe = PORTFOLIO_UNIVERSES.some(u => u.key === raw?.universe) ? raw.universe : "all";
  prefs.fractional = !(raw?.fractional === false || raw?.fractional === "false");
  prefs.options = !(raw?.options === false || raw?.options === "false");
  return prefs;
}

/* ------------------------------------------------------------------ helpers */

const usd = (v) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (q) => Number.isInteger(q) ? String(q) : String(+q.toFixed(4));
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const nextWeekday = (d) => { let t = addDays(d, 1); while (t.getDay() === 0 || t.getDay() === 6) t = addDays(t, 1); return t; };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shortDay = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Shares for `dollars` at `price`: cut to SHARE_STEP with a MIN_ORDER minimum when fractional, else whole shares. */
function sharesFor(dollars, price, fractional) {
  if (!(price > 0) || !(dollars > 0)) return 0;
  if (!fractional) return Math.floor(dollars / price + 1e-9);
  const q = Math.round(Math.floor(dollars / price / SHARE_STEP) * SHARE_STEP * 1e4) / 1e4;
  return q * price >= MIN_ORDER ? q : 0;
}

/** Annualized volatility used for weighting and risk: the build's GJR-GARCH forecast, else 30-day realized. */
const volOf = (item) => isNum(item.volForecast?.vol21) ? item.volForecast.vol21 : isNum(item.hv30) ? item.hv30 : null;

/* ------------------------------------------------------------------ weights */

/**
 * Inverse-volatility weights summing to `total`, each at most `cap`: the classic water-filling (fix the names over
 * the cap at the cap and share what is left among the rest, until none is over). Then each sector is held to
 * `sectorCap` by scaling its names down; what that frees is returned, not spread, so a narrow list leans on the core.
 */
export function riskWeights(items, total, cap, sectorCap) {
  const w = new Map();
  let open = items.filter(it => it.vol > 0), left = total;
  while (open.length) {
    const inv = open.reduce((s, it) => s + 1 / it.vol, 0);
    const over = open.filter(it => left * (1 / it.vol) / inv > cap);
    if (!over.length) {
      for (const it of open) w.set(it.ticker, left * (1 / it.vol) / inv);
      break;
    }
    for (const it of over) { w.set(it.ticker, cap); left -= cap; }
    open = open.filter(it => !over.includes(it));
  }
  const bySector = new Map();
  for (const it of items) if (w.has(it.ticker)) {
    const key = it.sector ?? it.ticker;
    bySector.set(key, (bySector.get(key) ?? 0) + w.get(it.ticker));
  }
  for (const it of items) {
    if (!w.has(it.ticker)) continue;
    const sum = bySector.get(it.sector ?? it.ticker);
    if (sum > sectorCap) w.set(it.ticker, w.get(it.ticker) * sectorCap / sum);
  }
  return w;
}

/* ------------------------------------------------------------------ methods */

/**
 * The entry methods, in the order they are considered for a stock. `applies` decides from the holding and the plan;
 * `build` returns { key, label, summary, detail[], ...figures }. Adding a strategy is one more entry here.
 */
export const METHODS = [
  {
    key: "csp", label: "Cash-secured put",
    why: "Paid to wait for the entry price: options are expensive against the volatility forecast, and the cash covers 100 shares at the strike.",
    applies: (h, ctx) => h.role === "stock" && h.bucket === "strong" && ctx.prefs.options && h.optionsRich && h.putStrike && h.dollars >= h.putStrike * 100,
    build: (h) => {
      const contracts = Math.floor(h.dollars / (h.putStrike * 100));
      const o = h.item.options;
      const iv = isNum(o.put25Iv) ? o.put25Iv : o.impliedVolatility;
      const premium = blackScholes("put", h.price, h.putStrike, o.daysToExpiration / 365, iv);
      return {
        contracts, strike: h.putStrike, expiration: o.expiration, premium, collateral: contracts * h.putStrike * 100,
        summary: `Sell ${contracts} ${h.ticker} ${o.expiration} $${h.putStrike} put${contracts === 1 ? "" : "s"}, about ${usd(premium * 100 * contracts)} credit`,
        detail: [`Keeps ${usd(contracts * h.putStrike * 100)} in cash. If the price is below $${h.putStrike} at expiry you buy ${contracts * 100} shares there; otherwise you keep the premium.`, "Premium is a Black-Scholes estimate, not a quote."]
      };
    }
  },
  {
    key: "lump", label: "Lump sum",
    why: "Buy it all now. Historically lump sum beats spreading purchases out about two times in three, because markets tend to rise while you wait.",
    applies: (h) => h.role === "core" || h.bucket === "buy",
    build: (h) => ({
      summary: `Buy ${qtyText(h.shares)} ${h.ticker} share${h.shares === 1 ? "" : "s"} now (${usd(h.cost)})`,
      detail: h.maxPrice ? [`Skip above ${usd(h.maxPrice)}: past that, reward/risk falls below ${RULES.buyZone.rewardRisk} : 1.`] : []
    })
  },
  {
    key: "limit", label: "Limit at preferred entry",
    why: "Close to the preferred entry zone: a limit at its top fills often enough, and buys cheaper when it does.",
    applies: (h) => h.bucket === "strong" && isNum(h.gap) && h.gap <= LIMIT_GAP && isNum(h.zoneHigh),
    build: (h, ctx) => {
      const odds = FILL_ODDS.find(([gap]) => h.gap <= gap)[1];
      const shares = sharesFor(h.dollars, h.zoneHigh, ctx.prefs.fractional);
      const fallback = addDays(ctx.today, Math.min(ctx.prefs.horizonDays, 30));
      return {
        limit: h.zoneHigh, fillOdds: odds, fallback: isoDay(fallback), shares,
        summary: `Limit buy ${qtyText(shares)} at ${usd(h.zoneHigh)}; if unfilled by ${shortDay(fallback)}, buy at market`,
        detail: [`Price is ${(100 * h.gap).toFixed(1)}% above the zone. In the replay, limits this close filled about ${Math.round(100 * odds)}% of the time within a month, and waiting came out even with buying at once, so the fallback keeps you from missing the position.`]
      };
    }
  },
  {
    key: "dca", label: "DCA schedule",
    why: "A strong business above its entry zone: a limit this far away rarely fills (about 1 in 5 or less), so buy in equal weekly slices instead.",
    applies: (h) => h.bucket === "strong",
    build: (h, ctx) => {
      // Weekly slices across the holding period, as many as still buy something after rounding to the share step.
      let count = clamp(Math.round(ctx.prefs.horizonDays / 7), 1, 6);
      while (count > 1 && !(sharesFor(h.dollars / count, h.price, ctx.prefs.fractional) > 0)) count--;
      const slice = h.dollars / count;
      const tranches = [];
      let day = nextWeekday(ctx.today);
      for (let k = 0; k < count; k++) {
        tranches.push({ date: isoDay(day), dollars: slice, shares: sharesFor(slice, h.price, ctx.prefs.fractional) });
        day = addDays(day, 7);
      }
      return {
        tranches,
        summary: count > 1 ? `${count} weekly buys of ${usd(slice)}: ${tranches.map(t => shortDay(new Date(`${t.date}T12:00:00`))).join(", ")}` : `Buy ${qtyText(h.shares)} now (too small to split)`,
        detail: [`About ${qtyText(sharesFor(slice, h.price, ctx.prefs.fractional))} shares each at today's price; the count moves with the price.`]
      };
    }
  }
];

/** An overlay on a holding already owned or being bought: income from selling a call against 100-share lots. */
export const OVERLAYS = [
  {
    key: "cc", label: "Covered call",
    why: "Options are expensive against the volatility forecast and the holding has 100+ shares: selling a call at the target earns premium, giving up gains above it.",
    applies: (h, ctx) => ctx.prefs.options && h.shares >= 100 && h.optionsRich && h.callStrike,
    build: (h) => {
      const o = h.item.options;
      const contracts = Math.floor(h.shares / 100);
      const iv = isNum(o.call25Iv) ? o.call25Iv : o.impliedVolatility;
      const premium = blackScholes("call", h.price, h.callStrike, o.daysToExpiration / 365, iv);
      return {
        contracts, strike: h.callStrike, expiration: o.expiration, premium,
        summary: `Sell ${contracts} ${o.expiration} $${h.callStrike} call${contracts === 1 ? "" : "s"}, about ${usd(premium * 100 * contracts)} credit`,
        detail: [`Caps the gain above $${h.callStrike} until ${o.expiration}. Premium is a Black-Scholes estimate, not a quote.`]
      };
    }
  }
];

/* ------------------------------------------------------------------ the plan */

/**
 * @param evaluations evaluateAsset() results for every tracked record
 * @param prefs normalizePortfolioPrefs() input
 * @param signals signalReadings() Map (js/edge.js), for ordering and the expected edge; may be empty
 * @param model frozenModel() with `sessions`, or null
 * @param universe market.json `universe` (for the primary list); screened: market.json `screened` (the weekly screen's picks)
 * @returns { prefs, style, holdings[], cash, invested, sectors[], stats, notes[] }
 */
export function buildPortfolio(evaluations, prefs, { signals = new Map(), model = null, universe = null, screened = [], now = new Date() } = {}) {
  const p = normalizePortfolioPrefs(prefs);
  const style = styleFor(p.stocksShare);
  const excluded = new Set(p.excluded);
  const ctx = { prefs: p, today: startOfDay(now) };
  const notes = [];
  const picks = new Set(screened);
  const inUniverse = (e) => p.universe === "primary" ? (universe?.primary ?? []).includes(e.item.ticker) || CORE_TICKERS.includes(e.item.ticker)
    : p.universe === "tracked" ? !picks.has(e.item.ticker)
    : true;
  const pool = evaluations.filter(inUniverse);

  const coreEval = pool.find(e => CORE_TICKERS.includes(e.item.ticker));
  const bucketRank = { buy: 0, strong: 1 };
  const candidates = pool
    .filter(e => !e.item.etf && !excluded.has(e.item.ticker) && e.bucket in bucketRank && isNum(e.item.price) && volOf(e.item))
    .sort((a, b) => bucketRank[a.bucket] - bucketRank[b.bucket]
      || (signals.get(b.item.ticker)?.expected ?? 0) - (signals.get(a.item.ticker)?.expected ?? 0)
      || (b.overall ?? 0) - (a.overall ?? 0))
    .slice(0, style.maxNames);
  if (!candidates.length && style.maxNames > 0) notes.push(`No ${excluded.size ? "remaining " : ""}stock is in the buy zone or rated strong right now, so the whole plan sits in the core.`);

  const stockShare = coreEval ? 1 - style.core : 1;
  const weights = riskWeights(candidates.map(e => ({ ticker: e.item.ticker, sector: e.item.sector, vol: volOf(e.item) })), stockShare, style.maxWeight, style.sectorCap);

  const holding = (e, role, weight) => {
    const item = e.item, lv = e.levels, o = item.options;
    const pricing = optionsPricing(item);
    const liquid = o && isNum(o.atmCallAsk) && o.atmCallAsk > 0 && o.atmCallOpenInterest >= RULES.minOpenInterest
      && (o.atmCallAsk - o.atmCallBid) / o.atmCallAsk * 100 <= RULES.maxSpreadPct;
    const step = strikeStep(item.price);
    const putStrike = isNum(lv.zoneHigh) && lv.zoneHigh < item.price ? Math.floor(lv.zoneHigh / step) * step : null;
    const callStrike = isNum(lv.target) && lv.target > item.price ? Math.ceil(lv.target / step) * step : null;
    const dollars = weight * p.account;
    const shares = sharesFor(dollars, item.price, p.fractional);
    return {
      ticker: item.ticker, name: item.name ?? item.ticker, sector: role === "core" ? "Index" : item.sector ?? "Other",
      role, item, bucket: e.bucket, verdict: e.verdict, price: item.price, dollars, shares, cost: shares * item.price,
      vol: volOf(item), beta: isNum(item.beta) ? item.beta : role === "core" ? 1 : null,
      expected: signals.get(item.ticker)?.expected ?? null,
      gap: lv.distanceFromIdeal, zoneHigh: lv.zoneHigh,
      maxPrice: e.bucket === "buy" && isNum(lv.target) && isNum(lv.entrySupport) ? maxEntryPrice(lv.target, lv.entrySupport) : null,
      optionsRich: !!(liquid && pricing && pricing.ratio >= RULES.ivExpensiveRatio && !e.earningsWarning),
      putStrike: liquid && putStrike > 0 ? putStrike : null,
      callStrike: liquid ? callStrike : null,
      earnings: item.catalysts?.nextEarningsDate ?? null
    };
  };

  // Stocks the account can't buy a share (or $1) of go back to the core.
  const stocks = [], unaffordable = [];
  for (const e of candidates) {
    const h = holding(e, "stock", weights.get(e.item.ticker) ?? 0);
    if (h.shares > 0 || (h.bucket === "strong" && sharesFor(h.dollars, Math.min(h.price, h.zoneHigh ?? h.price), p.fractional) > 0)) stocks.push(h);
    else unaffordable.push(h.ticker);
  }
  if (unaffordable.length) {
    notes.push(p.fractional
      ? `${unaffordable.join(", ")}: each share of the plan came to less than the $${MIN_ORDER} minimum order, so the core holds it instead.`
      : `${unaffordable.join(", ")}: one share costs more than each one's share of the plan, so the core holds it instead. Allowing fractional shares would keep them.`);
  }
  const placed = stocks.reduce((s, h) => s + h.dollars / p.account, 0);
  const coreWeight = coreEval ? 1 - placed : 0;
  if (coreEval && placed < stockShare - 1e-9 && candidates.length) {
    notes.push(`Caps of ${(100 * style.maxWeight).toFixed(0)}% per stock and ${(100 * style.sectorCap).toFixed(0)}% per sector left ${(100 * (stockShare - placed)).toFixed(1)}% that the core holds instead.`);
  }
  const holdings = [...(coreEval ? [holding(coreEval, "core", coreWeight)] : []), ...stocks];

  for (const h of holdings) {
    const method = METHODS.find(m => m.applies(h, ctx));
    h.method = method ? { key: method.key, label: method.label, why: method.why, ...method.build(h, ctx) } : null;
    if (h.method?.key === "limit") { h.shares = h.method.shares; h.cost = h.shares * h.method.limit; }
    if (h.method?.key === "dca") { h.shares = h.method.tranches.reduce((s, t) => s + t.shares, 0); h.cost = h.method.tranches.reduce((s, t) => s + t.shares * h.price, 0); }
    if (h.method?.key === "csp") { h.shares = 0; h.cost = h.method.collateral; }
    const overlay = OVERLAYS.find(m => m.applies(h, ctx));
    h.overlay = overlay ? { key: overlay.key, label: overlay.label, why: overlay.why, ...overlay.build(h, ctx) } : null;
    h.weight = h.cost / p.account;
    if (h.earnings && (new Date(`${h.earnings}T12:00:00`) - ctx.today) / DAY_MS <= p.horizonDays && h.role === "stock") {
      h.note = `Earnings on ${h.earnings}, inside the holding period: expect a gap either way.`;
    }
  }

  const core = holdings.find(h => h.role === "core");
  if (core && core.shares === 0 && core.dollars > 0) {
    notes.push(`One ${core.ticker} share (${usd(core.price)}) costs more than the ${usd(core.dollars)} the core should hold, so it stays in cash. Allow fractional shares, or buy a lower-priced fund that tracks the same index.`);
  }
  const invested = holdings.reduce((s, h) => s + h.cost, 0);
  const cash = Math.max(0, p.account - invested);
  if (cash > 0.005 * p.account && !p.fractional && !(core && core.shares === 0)) notes.push(`${usd(cash)} stays in cash: whole shares don't divide the account exactly.`);

  const sectors = [...holdings.reduce((m, h) => m.set(h.sector, (m.get(h.sector) ?? 0) + h.weight), new Map())]
    .map(([sector, weight]) => ({ sector, weight })).sort((a, b) => b.weight - a.weight);
  return { prefs: p, style, holdings, cash, invested, sectors, stats: portfolioStats(holdings, coreEval?.item, p, model), notes };
}

/**
 * Risk and expected edge of the plan. Single-index model: each holding's variance splits into market (β²σ²_m) and
 * stock-specific (σ² − β²σ²_m) parts, the specific parts uncorrelated, so
 *   σ²_p = (Σ wβ)² σ²_m + Σ w² (σ² − β²σ²_m).
 * Cash has no risk. A missing beta is taken as 1. The expected edge is the frozen signal's expected return relative to
 * the market, weighted and scaled to the holding period: unproven, and zero for the core.
 */
export function portfolioStats(holdings, marketItem, prefs, model) {
  const sm = marketItem ? volOf(marketItem) : null;
  if (!isNum(sm)) return null;
  let beta = 0, specific = 0, weightedVol = 0, edge = 0, edgeKnown = false;
  for (const h of holdings) {
    const w = h.weight, b = isNum(h.beta) ? h.beta : 1, v = isNum(h.vol) ? h.vol : sm;
    beta += w * b;
    specific += w * w * Math.max(0, v * v - b * b * sm * sm);
    weightedVol += w * v;
    if (isNum(h.expected) && model) { edge += w * h.expected * (prefs.horizonDays * 252 / 365) / model.sessions; edgeKnown = true; }
  }
  const vol = Math.sqrt(beta * beta * sm * sm + specific);
  const invested = holdings.reduce((s, h) => s + h.cost, 0);
  if (!Number.isFinite(vol)) throw new Error("Portfolio volatility is not finite; check the holdings' volatility and beta");
  return {
    vol, beta, marketVol: sm,
    diversification: vol > 0 ? weightedVol / vol : null,
    // Weights are shares of the whole account (cash carries no risk), so the range is in account dollars.
    range90: 1.645 * vol * Math.sqrt(prefs.horizonDays / 365) * prefs.account,
    edge: edgeKnown ? edge : null,
    costs: invested * SHARE_COST_PER_SIDE
  };
}

/** The plan as plain text, for an AI agent or a note. */
export function portfolioText(plan, { generatedAt, url } = {}) {
  const p = plan.prefs, s = plan.stats;
  const lines = [
    `StockWatcher portfolio plan (${plan.style.label}, ${Math.round(100 * p.stocksShare)}% in stocks): ${usd(p.account)} account, ${p.horizonDays}-day horizon, ${p.fractional ? "fractional shares" : "whole shares only"}, ${p.options ? "options allowed" : "no options"}${p.excluded.length ? `, never picking ${p.excluded.join(", ")}` : ""}.`,
    `Data built ${generatedAt ?? "N/A"}. Rule-based research, not investment advice.`,
    ""
  ];
  for (const h of plan.holdings) {
    lines.push(`- ${h.ticker} (${h.role === "core" ? "core index" : h.verdict}): ${(100 * h.weight).toFixed(1)}%, ${usd(h.cost)}. ${h.method?.label ?? "No method"}: ${h.method?.summary ?? ""}.`
      + (h.overlay ? ` Overlay, ${h.overlay.label}: ${h.overlay.summary}.` : "") + (h.note ? ` ${h.note}` : ""));
  }
  if (plan.cash > 0.005) lines.push(`- Cash: ${usd(plan.cash)}`);
  if (s) {
    lines.push("", `Risk: volatility ${(100 * s.vol).toFixed(1)}% a year against ${(100 * s.marketVol).toFixed(1)}% for the index alone; beta ${s.beta.toFixed(2)}; diversification ratio ${s.diversification?.toFixed(2) ?? "N/A"}.`,
      `About 90% of the time the plan should end the ${p.horizonDays} days within ±${usd(s.range90)} of where it started (normal approximation).`,
      `Expected edge over the market: ${s.edge === null ? "N/A" : `${(100 * s.edge).toFixed(2)}%`} (from an unproven signal model), before about ${usd(s.costs)} of trading costs to buy in.`);
  }
  if (plan.notes.length) lines.push("", ...plan.notes.map(n => `Note: ${n}`));
  lines.push("", "Caveat: the stock picks are tilts, not predictions; none of the app's signals has passed its out-of-sample test yet. Diversification, not the picks, is what this plan relies on.");
  if (url) lines.push(`Source: ${url}`);
  return lines.join("\n");
}
