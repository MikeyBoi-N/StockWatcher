/**
 * Email alert rules, shared by the settings dialog (index.html) and the sender (scripts/send_alerts.mjs).
 *
 * Alerts fire on transitions between two consecutive data builds: a stock that stays actionable is reported
 * once, and a failed build loses nothing because the next build is compared against the last deployed one.
 */
import { classifyEvaluations, determineMarketRegime, evaluateAsset } from "./engine.js";

export const ALERT_TRIGGERS = [
  { id: "actionable", label: "Becomes actionable", hint: "Score 70+, at major support, no earnings inside 14 days" },
  { id: "avoid", label: "Drops to avoid", hint: "Score under 55 or technically extended" },
  { id: "score", label: "Score reaches my threshold" },
  { id: "supportBreak", label: "Price falls below major support" },
  { id: "earnings", label: "Earnings coming up" },
  { id: "filing", label: "Files a material 8-K", hint: "Restructuring, new debt, leadership change, impairment and similar SEC filings" },
  { id: "regime", label: "Market regime changes", hint: "SPY and QQQ vs their 50d and 200d SMAs" }
];

export const DEFAULT_ALERT_PREFS = {
  enabled: false,
  triggers: { actionable: true, avoid: false, score: false, supportBreak: true, earnings: true, filing: true, regime: true },
  scoreThreshold: 75,
  earningsDays: 7
};

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
    scoreThreshold: clampInt(r.scoreThreshold, 1, 100, DEFAULT_ALERT_PREFS.scoreThreshold),
    earningsDays: clampInt(r.earningsDays, 1, 30, DEFAULT_ALERT_PREFS.earningsDays)
  };
}

/** Scores a data/market.json payload into the fields alerts compare. */
export function summarizeSnapshot(market) {
  const records = Object.values(market.stocks);
  const { regime } = determineMarketRegime(records);
  const evaluations = records.map(item => evaluateAsset(item, regime));
  classifyEvaluations(evaluations);
  return {
    generatedAt: market.generatedAt,
    regime,
    stocks: new Map(evaluations.map(e => [e.item.ticker, {
      ticker: e.item.ticker,
      name: e.item.name,
      bucket: e.bucket,
      score: e.totalScore,
      extended: e.tech.isExtended,
      price: e.item.price,
      support: e.item.majorSupport,
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

    if (on.actionable && a.bucket !== "actionable" && b.bucket === "actionable") {
      add("actionable", `Now actionable at ${money(b.price)}: score ${b.score}, at major support ${money(b.support)}. Vehicle: ${b.vehicle}.`);
    }
    if (on.avoid && a.bucket !== "avoid" && b.bucket === "avoid") {
      add("avoid", b.extended
        ? `Dropped to avoid at ${money(b.price)}: technically extended (score ${b.score}).`
        : `Dropped to avoid at ${money(b.price)}: score fell from ${a.score} to ${b.score}.`);
    }
    if (on.score && a.score < prefs.scoreThreshold && b.score >= prefs.scoreThreshold) {
      add("score", `Score rose from ${a.score} to ${b.score}, reaching your threshold of ${prefs.scoreThreshold}.`);
    }
    if (on.supportBreak && isNum(a.support) && isNum(b.support) && a.price >= a.support && b.price < b.support) {
      add("supportBreak", `Fell below major support ${money(b.support)} to ${money(b.price)}.`);
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
