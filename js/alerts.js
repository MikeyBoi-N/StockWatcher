/**
 * Email alert rules, shared by the settings dialog (index.html) and the sender (scripts/send_alerts.mjs).
 *
 * Alerts fire on transitions between two consecutive data builds: a stock that stays actionable is reported
 * once, and a failed build loses nothing because the next build is compared against the last deployed one.
 */
import { SCORE_LABELS, buildMarketContext, evaluateAsset } from "./engine.js";

export const ALERT_TRIGGERS = [
  { id: "actionable", label: "Enters the buy zone", hint: "Quality, Trend, Entry and Trade all clear their bars, chase risk isn't high, no earnings inside 14 days" },
  { id: "avoid", label: "Drops to avoid", hint: "Broken trend (Trend under 35) or weak business (Quality under 40)" },
  { id: "score", label: "Score reaches my threshold" },
  { id: "supportBreak", label: "Price falls below entry support", hint: "The trade invalidation level" },
  { id: "earnings", label: "Earnings coming up" },
  { id: "filing", label: "Files a material 8-K", hint: "Restructuring, new debt, leadership change, impairment and similar SEC filings" },
  { id: "regime", label: "Market regime changes", hint: "SPY and QQQ vs their 50d and 200d SMAs" }
];

export const DEFAULT_ALERT_PREFS = {
  enabled: false,
  triggers: { actionable: true, avoid: false, score: false, supportBreak: true, earnings: true, filing: true, regime: true },
  scoreKey: "entry",
  scoreThreshold: 75,
  earningsDays: 7
};

export const ALERT_SCORE_KEYS = ["overall", "quality", "trend", "entry", "trade"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const money = (v) => `$${v.toFixed(2)}`;
const clampInt = (v, lo, hi, fallback) => isNum(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;

/** Stored prefs are user-written; anything missing or malformed falls back to the defaults. */
export function normalizeAlertPrefs(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const t = r.triggers && typeof r.triggers === "object" ? r.triggers : {};
  return {
    enabled: r.enabled === true,
    triggers: Object.fromEntries(ALERT_TRIGGERS.map(({ id }) => [id, typeof t[id] === "boolean" ? t[id] : DEFAULT_ALERT_PREFS.triggers[id]])),
    scoreKey: ALERT_SCORE_KEYS.includes(r.scoreKey) ? r.scoreKey : DEFAULT_ALERT_PREFS.scoreKey,
    scoreThreshold: clampInt(r.scoreThreshold, 1, 100, DEFAULT_ALERT_PREFS.scoreThreshold),
    earningsDays: clampInt(r.earningsDays, 1, 30, DEFAULT_ALERT_PREFS.earningsDays)
  };
}

/** Scores a data/market.json payload into the fields alerts compare. */
export function summarizeSnapshot(market) {
  const records = Object.values(market.stocks);
  const context = buildMarketContext(records, market.sectors);
  const evaluations = records.map(item => evaluateAsset(item, context));
  return {
    generatedAt: market.generatedAt,
    regime: context.regime,
    stocks: new Map(evaluations.map(e => [e.item.ticker, {
      ticker: e.item.ticker,
      name: e.item.name,
      bucket: e.bucket,
      verdict: e.verdict,
      scores: { overall: e.overall, quality: e.scores.quality.score, trend: e.scores.trend.score, entry: e.scores.entry.score, trade: e.scores.trade.score },
      price: e.item.price,
      support: e.levels.entrySupport,
      zoneLow: e.levels.zoneLow,
      zoneHigh: e.levels.zoneHigh,
      daysToEarnings: e.item.catalysts.daysToEarnings,
      earningsDate: e.item.catalysts.nextEarningsDate,
      earningsEstimated: e.item.catalysts.earningsDateEstimated,
      vehicle: e.optionsEval.recommendation,
      // null when the build couldn't read filings, so a first successful read doesn't alert on old events
      filingEvents: Array.isArray(e.item.filingEvents) ? e.item.filingEvents : null
    }]))
  };
}

/**
 * What changed for one user between two summaries.
 * @param {ReturnType<typeof summarizeSnapshot>} prev the previously deployed build
 * @param {ReturnType<typeof summarizeSnapshot>} cur the new build
 * @param {ReturnType<typeof normalizeAlertPrefs>} prefs
 * @param {string[]} watchlist
 * @returns {{ticker: string|null, name: string|null, trigger: string, message: string}[]} regime alert first, then by watchlist order
 */
export function alertsForUser(prev, cur, prefs, watchlist) {
  const on = prefs.triggers;
  const alerts = [];
  if (on.regime && prev.regime !== cur.regime) {
    alerts.push({ ticker: null, name: null, trigger: "regime", message: `Market regime changed from ${prev.regime} to ${cur.regime}.` });
  }

  const inEarningsWindow = (s) => isNum(s.daysToEarnings) && s.daysToEarnings >= 0 && s.daysToEarnings <= prefs.earningsDays;
  for (const ticker of new Set(watchlist)) {
    const a = prev.stocks.get(ticker);
    const b = cur.stocks.get(ticker);
    if (!a || !b) continue;
    const add = (trigger, message) => alerts.push({ ticker, name: b.name, trigger, message });

    const s = b.scores;
    if (on.actionable && a.bucket !== "buy" && b.bucket === "buy") {
      const zone = isNum(b.zoneLow) ? ` Preferred entry ${money(b.zoneLow)}–${money(b.zoneHigh)}, invalidation below ${money(b.support)}.` : "";
      add("actionable", `Entered the buy zone at ${money(b.price)}: Quality ${s.quality ?? "N/A"}, Trend ${s.trend}, Entry ${s.entry}, Trade ${s.trade}.${zone} Vehicle: ${b.vehicle}.`);
    }
    if (on.avoid && a.bucket !== "avoid" && b.bucket === "avoid") {
      add("avoid", `${b.verdict} at ${money(b.price)}: Quality ${s.quality ?? "N/A"}, Trend ${s.trend} (was ${a.scores.trend}).`);
    }
    const key = prefs.scoreKey;
    if (on.score && isNum(a.scores[key]) && isNum(b.scores[key]) && a.scores[key] < prefs.scoreThreshold && b.scores[key] >= prefs.scoreThreshold) {
      add("score", `${SCORE_LABELS[key]} score rose from ${a.scores[key]} to ${b.scores[key]}, reaching your threshold of ${prefs.scoreThreshold}.`);
    }
    if (on.supportBreak && isNum(a.support) && isNum(b.support) && a.price >= a.support && b.price < b.support) {
      add("supportBreak", `Fell below entry support ${money(b.support)} to ${money(b.price)} (trade invalidation).`);
    }
    if (on.earnings && inEarningsWindow(b) && !inEarningsWindow(a)) {
      add("earnings", `Earnings in ${b.daysToEarnings} day${b.daysToEarnings === 1 ? "" : "s"} (${b.earningsDate}${b.earningsEstimated ? ", estimated" : ""}).`);
    }
    if (on.filing && a.filingEvents && b.filingEvents) {
      const seen = new Set(a.filingEvents.map(f => f.url));
      for (const filing of b.filingEvents) {
        // Item 2.02 is the routine results release; earnings alerts already cover it.
        const items = filing.items.filter(i => i.code !== "2.02");
        if (!seen.has(filing.url) && items.length) {
          add("filing", `Filed an 8-K on ${filing.date}: ${items.map(i => i.label).join("; ")}. ${filing.url}`);
        }
      }
    }
  }
  return alerts;
}
