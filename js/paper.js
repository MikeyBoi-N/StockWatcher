/**
 * The paper record: hypotheses written down before the data that judges them exists, then scored as that data arrives.
 *
 * Backtests on history are exploratory: every idea tried on the same five years makes it likelier that one looks good
 * by luck. A registered hypothesis fixes everything in advance (what is measured, on which stocks, against which
 * benchmark, over which window, how many independent tests it needs, and the bar it must clear) and is scored only on
 * weeks after its registration date. Registrations live in data/paper/registry.json, written by
 * scripts/register_paper.mjs and never edited afterwards; the commit that adds one is its timestamp.
 *
 * Data comes from the same pipelines as the scorecard: the weekly point-in-time replay (rebuilt by every data build,
 * so new weeks keep arriving) and the verdicts the app actually published (Firestore snapshots).
 *
 * A registration stores fingerprints of the engine's rules, the signal definitions and the measurement code. If any of
 * them changes later, the hypotheses that depend on it are flagged, because their numbers would then describe
 * something other than what was registered. The fingerprint is a tripwire, not a proof: it covers the functions
 * listed below, not every line they call.
 */
import * as engine from "./engine.js";
import { compareWithSector, excessReturn, forwardReturn, liveRecord, spearman, testDates, trailingBeta, ENTRY_LAG } from "./replay.js";
import { FIT_KEYS, SIGNALS, buildPanel } from "./signals.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** 32-bit FNV-1a of a string, as 8 hex digits. */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
// Source text of a function or value, with Windows line endings removed so a checkout on any OS fingerprints the same.
const source = (v) => (typeof v === "function" ? v.toString() : JSON.stringify(v)).replace(/\r/g, "");

/**
 * Fingerprints of what a registered hypothesis depends on:
 *   engine       the scoring rules and the functions that turn inputs into scores and verdicts
 *   measurement  how outcomes are measured (entry lag, total return, benchmarks, sector comparison, beta, test dates)
 *   signals      each signal's definition, by key
 */
export function fingerprints() {
  return {
    engine: fnv([engine.RULES, engine.monthlySigma, engine.determineMarketRegime, engine.buildMarketContext, engine.computeLevels,
      engine.scoreQuality, engine.scoreTrend, engine.scoreEntry, engine.scoreTrade, engine.overallScore, engine.diagnose,
      engine.classify, engine.evaluateAsset].map(source).join("\n")),
    measurement: fnv([ENTRY_LAG, forwardReturn, excessReturn, compareWithSector, trailingBeta, testDates, spearman, buildPanel].map(source).join("\n")),
    signals: Object.fromEntries(SIGNALS.map(s => [s.key, fnv(source(s.value))]))
  };
}

/** Which fingerprints a hypothesis depends on. Engine scores and verdicts depend on the engine; every signal on its own definition. */
function dependsOn(h) {
  const keys = ["measurement"];
  if (h.kind === "bucket" || (h.kind === "signal" && ["overall", "trend", "entry", "trade"].includes(h.signal))) keys.push("engine");
  if (h.kind === "model") keys.push("engine", ...Object.keys(h.weights).map(k => `signals.${k}`));
  if (h.kind === "signal") keys.push(`signals.${h.signal}`);
  return keys;
}

/** Fingerprint paths that differ between a registration and the code running now. */
function changed(spec, now, h) {
  const at = (fp, path) => path.split(".").reduce((o, k) => o?.[k], fp);
  return dependsOn(h).filter(path => at(spec.fingerprints, path) !== at(now, path));
}

function meanSE(values) {
  const n = values.length;
  if (!n) return { mean: null, se: null, n: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return { mean, se: n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n) : null, n };
}

/**
 * The per-date statistic of a replay-based hypothesis on the weeks after registration, thinned so windows never
 * overlap. `signal`: rank correlation of the signal with what followed, times the registered direction. `model`:
 * the frozen model's top fifth minus bottom fifth. Returns the list of per-date values.
 */
function replayValues(h, spec, replay, states) {
  const universe = new Set(spec.universe);
  const panel = buildPanel(replay, states, { sessions: h.sessions, include: (t) => universe.has(t), benchmark: h.benchmark });
  const after = Date.parse(`${spec.registeredOn}T23:59:59Z`);
  const dates = panel.dates.filter(d => d.t > after && d.rows.some(r => r.excess !== null));
  const picked = new Set(testDates(dates.map(d => d.t), h.sessions));
  const values = [];
  for (const d of dates.filter(d => picked.has(d.t))) {
    const rows = d.rows.filter(r => r.excess !== null);
    if (h.kind === "signal") {
      const valid = rows.filter(r => isNum(r.ranks[h.signal]));
      const ic = spearman(valid.map(r => r.ranks[h.signal]), valid.map(r => r.excess));
      if (ic !== null) values.push(h.direction * ic);
    } else if (h.kind === "model" && rows.length >= 10) {
      const score = (r) => Object.entries(h.weights).reduce((s, [k, w]) => s + w * (r.ranks[k] ?? 0), 0);
      const sorted = [...rows].sort((a, b) => score(a) - score(b));
      const fifth = Math.floor(sorted.length / 5);
      const avg = (list) => list.reduce((s, r) => s + r.excess, 0) / list.length;
      values.push(h.direction * (avg(sorted.slice(-fifth)) - avg(sorted.slice(0, fifth))));
    }
  }
  return values;
}

/**
 * Scores every hypothesis of a registration on data after its registration date.
 * @param spec a registry entry; @param replay decoded replay.json; @param states replayStates(); @param snapshots
 *   published snapshots (null while loading: published-verdict hypotheses then read as waiting)
 * Returns [{ ...hypothesis, estimate: {mean, se, n}, z, status, changed }] where status is
 *   "invalid"     a fingerprint it depends on changed since registration
 *   "collecting"  fewer independent tests than `minDates` so far (the estimate is shown but not judged)
 *   "passed"      at `minDates` or more, z >= the registered bar; "failed" otherwise
 */
export function scorePaper(spec, replay, states, snapshots) {
  const now = fingerprints();
  return spec.hypotheses.map(h => {
    const diff = changed(spec, now, h);
    let values = null, estimate;
    if (h.kind === "bucket") {
      if (snapshots) {
        const live = liveRecord(replay, snapshots, { sessions: h.sessions, benchmark: h.benchmark, since: spec.registeredOn });
        const b = live.buckets[h.bucket].excess;
        estimate = { mean: isNum(b.mean) ? h.direction * b.mean : null, se: b.se, n: b.n };
      }
    } else {
      values = replayValues(h, spec, replay, states);
      estimate = meanSE(values);
    }
    estimate ??= { mean: null, se: null, n: 0 };
    const z = isNum(estimate.mean) && estimate.se > 0 ? estimate.mean / estimate.se : null;
    const status = diff.length ? "invalid"
      : estimate.n < h.minDates ? "collecting"
      : z !== null && z >= spec.passRule.z ? "passed" : "failed";
    return { ...h, estimate, z, status, changed: diff };
  });
}

/**
 * A new registration from the data available now (scripts/register_paper.mjs writes it to the registry).
 * Everything a hypothesis needs is fixed here; the model's weights come from `fit` (signals.js fitCompleted on every
 * week whose outcome had finished). `universe` is the replayed stock list at registration (ETFs excluded), frozen so
 * later additions can't change what is tested.
 */
export function newRegistration({ registeredOn, dataThrough, universe, fit }) {
  return {
    id: registeredOn,
    registeredOn,
    dataThrough,
    note: "Scored only on weeks after registeredOn. Do not edit; register a new entry instead.",
    fingerprints: fingerprints(),
    universe,
    passRule: { z: 2.25, why: "One-sided, 5% split across the four hypotheses (Bonferroni): the estimate must be at least 2.25 standard errors above zero once minDates independent tests exist." },
    model: { fittedOn: `${fit.dates} weeks, ${fit.rows} stock-weeks, outcomes finished by ${dataThrough}`, keys: FIT_KEYS },
    hypotheses: [
      {
        id: "H1", kind: "bucket", source: "published", bucket: "buy", sessions: 21, benchmark: "beta", direction: 1, minDates: 12,
        statement: "Stocks the app publishes as Buy zone beat risk-adjusted SPY over the next month.",
        measures: "Average return of that day's Buy-zone stocks over SPY scaled by each stock's beta, one published day per month"
      },
      {
        id: "H2", kind: "model", sessions: 21, benchmark: "beta", direction: 1, minDates: 12, weights: fit.weights,
        statement: "The fitted model, frozen today, ranks next month's winners: its top fifth beats its bottom fifth, risk-adjusted.",
        measures: "Top fifth minus bottom fifth by the frozen model's score, return over beta-scaled SPY, one week per month"
      },
      {
        id: "H3", kind: "signal", signal: "week", sessions: 21, benchmark: "beta", direction: -1, minDates: 12,
        statement: "Short-term reversal: last week's losers beat last week's winners over the next month, risk-adjusted.",
        measures: "Rank correlation of last week's return with the next month's return over beta-scaled SPY, sign flipped"
      },
      {
        id: "H4", kind: "signal", signal: "overall", sessions: 5, benchmark: "sector", direction: 1, minDates: 26,
        statement: "Stocks with higher engine Overall scores (price-based part) beat their sector peers over the next week.",
        measures: "Rank correlation of the replayed Overall score with the next week's return against sector peers"
      }
    ]
  };
}

