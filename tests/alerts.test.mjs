import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALERT_PREFS, alertsForUser, normalizeAlertPrefs } from "../js/alerts.js";

const stock = (overrides = {}) => ({
  ticker: "TEST", name: "Test Corp", bucket: "watch", verdict: "Watch", scores: { overall: 68, quality: 70, trend: 66, entry: 60, trade: 62 },
  price: 105, support: 100, zoneLow: 100.25, zoneHigh: 102,
  daysToEarnings: 30, earningsDate: "2026-10-14", earningsEstimated: false, vehicle: "SHARES", filingEvents: [], ...overrides
});
const snapshot = (stocks, regime = "BULLISH") => ({ generatedAt: "2026-09-14T15:00:00+00:00", regime, stocks: new Map(stocks.map(s => [s.ticker, s])) });
const allOn = normalizeAlertPrefs({ enabled: true, triggers: { actionable: true, avoid: true, score: true, supportBreak: true, earnings: true, filing: true, regime: true }, scoreKey: "entry", scoreThreshold: 75, earningsDays: 7 });
const triggers = (alerts) => alerts.map(a => a.trigger).sort();

test("unchanged snapshots produce no alerts", () => {
  const s = snapshot([stock()]);
  assert.deepEqual(alertsForUser(s, s, allOn, ["TEST"]), []);
});

test("entering the buy zone alerts once, staying in it does not", () => {
  const before = snapshot([stock()]);
  const after = snapshot([stock({ bucket: "buy", verdict: "Buy zone", scores: { overall: 80, quality: 70, trend: 70, entry: 82, trade: 70 }, price: 101 })]);
  const alerts = alertsForUser(before, after, allOn, ["TEST"]);
  assert.deepEqual(triggers(alerts), ["actionable", "score"]);
  assert.match(alerts.find(a => a.trigger === "score").message, /^Entry score rose from 60 to 82/);
  assert.match(alerts.find(a => a.trigger === "actionable").message, /Preferred entry \$100\.25–\$102\.00/);
  assert.deepEqual(alertsForUser(after, after, allOn, ["TEST"]), []);
});

test("the threshold alert watches the score the user picked", () => {
  const before = snapshot([stock()]);
  const after = snapshot([stock({ scores: { overall: 68, quality: 80, trend: 66, entry: 60, trade: 62 } })]);
  assert.deepEqual(alertsForUser(before, after, allOn, ["TEST"]), []);
  const onQuality = { ...allOn, scoreKey: "quality" };
  assert.match(alertsForUser(before, after, onQuality, ["TEST"])[0].message, /^Quality score rose from 70 to 80/);
  assert.equal(normalizeAlertPrefs({ scoreKey: "bogus" }).scoreKey, "entry");
});

test("only watchlist tickers alert, and disabled triggers stay quiet", () => {
  const before = snapshot([stock(), stock({ ticker: "OTHER" })]);
  const after = snapshot([stock({ price: 95 }), stock({ ticker: "OTHER", price: 95 })]);
  assert.deepEqual(alertsForUser(before, after, allOn, ["TEST"]).map(a => a.ticker), ["TEST"]);
  const noSupport = { ...allOn, triggers: { ...allOn.triggers, supportBreak: false } };
  assert.deepEqual(alertsForUser(before, after, noSupport, ["TEST"]), []);
});

test("earnings alert fires when entering the user's window, not on every day inside it", () => {
  const far = snapshot([stock({ daysToEarnings: 9 })]);
  const near = snapshot([stock({ daysToEarnings: 7 })]);
  const nearer = snapshot([stock({ daysToEarnings: 6 })]);
  assert.deepEqual(triggers(alertsForUser(far, near, allOn, ["TEST"])), ["earnings"]);
  assert.deepEqual(alertsForUser(near, nearer, allOn, ["TEST"]), []);
});

test("regime change alerts without a ticker; stocks missing from either build are skipped", () => {
  const before = snapshot([stock()], "BULLISH");
  const after = snapshot([], "CAUTIOUS");
  const alerts = alertsForUser(before, after, allOn, ["TEST"]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ticker, null);
});

test("malformed stored prefs fall back to defaults and clamp numbers", () => {
  assert.deepEqual(normalizeAlertPrefs(null), DEFAULT_ALERT_PREFS);
  const p = normalizeAlertPrefs({ enabled: "yes", triggers: { avoid: true, actionable: "no" }, scoreThreshold: 500, earningsDays: -3 });
  assert.equal(p.enabled, false);
  assert.equal(p.triggers.avoid, true);
  assert.equal(p.triggers.actionable, DEFAULT_ALERT_PREFS.triggers.actionable);
  assert.equal(p.scoreThreshold, 100);
  assert.equal(p.earningsDays, 1);
});

test("new material 8-Ks alert once; results releases and unreadable previous filings do not", () => {
  const restructuring = { date: "2026-09-10", form: "8-K", url: "https://www.sec.gov/a", items: [{ code: "2.05", label: "Restructuring (layoffs, closures or exit costs)", tone: "negative" }] };
  const results = { date: "2026-09-11", form: "8-K", url: "https://www.sec.gov/b", items: [{ code: "2.02", label: "Released results or a financial update", tone: "neutral" }] };
  const before = snapshot([stock()]);
  const after = snapshot([stock({ filingEvents: [results, restructuring] })]);
  const alerts = alertsForUser(before, after, allOn, ["TEST"]);
  assert.deepEqual(triggers(alerts), ["filing"]);
  assert.match(alerts[0].message, /Restructuring/);
  assert.deepEqual(alertsForUser(after, after, allOn, ["TEST"]), []);
  assert.deepEqual(alertsForUser(snapshot([stock({ filingEvents: null })]), after, allOn, ["TEST"]), []);
});
