/**
 * Records what the scoring engine says about every tracked stock into Firestore, one document per market day
 * (`history/{YYYY-MM-DD}`), so the Historical view can show how a recommendation changed and whether it worked.
 *
 * Runs on every data build. The three weekday builds all fold into that day's single entry as a running mean
 * (see js/history.js), so re-running this is safe in the sense that it never creates duplicate days - but each run
 * does add a sample, so do not replay the same build twice.
 *
 * Usage: node scripts/record_history.mjs [--dry-run] [--force]
 *   --dry-run  print the snapshot instead of writing it
 *   --force    record even when the data build is not from the current market day (it is skipped by default, so a
 *              build whose sources failed cannot fold the committed snapshot in as if it were fresh)
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service account key JSON (writes history/*, which firestore.rules keeps read-only
 *                             for everyone else; the Admin SDK bypasses rules)
 *
 * Without the Firebase setting the script logs a notice and exits cleanly, so the build still passes.
 */
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { buildMarketContext, evaluateAsset } from "../js/engine.js";
import { foldDay, marketDay, snapshotFromEvaluations } from "../js/history.js";

const MARKET_FILE = new URL("../data/market.json", import.meta.url);

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const market = JSON.parse(readFileSync(MARKET_FILE, "utf8"));

  const primary = new Set(market.universe?.primary ?? []);
  const records = Object.values(market.stocks ?? {}).map(r => ({ ...r, isPrimary: primary.has(r.ticker) }));
  if (!records.length) {
    console.log("No stocks in the data build; nothing to record.");
    return;
  }

  // build_market_data.py leaves the committed snapshot in place when its sources fail, so a build that is not from
  // today would fold yesterday's readings into today's average as if they were fresh.
  const day = marketDay(market.generatedAt);
  const force = process.argv.slice(2).includes("--force");
  if (day !== marketDay() && !force) {
    console.log(`NOTICE: the data build is from ${day}, not the current market day (${marketDay()}); skipping the history snapshot.`);
    return;
  }

  const context = buildMarketContext(records, market.sectors);
  const snapshot = snapshotFromEvaluations(records.map(item => evaluateAsset(item, context)), context);

  if (dryRun) {
    const sample = Object.entries(snapshot.tickers).slice(0, 5);
    console.log(`${day} (${snapshot.regime}): ${Object.keys(snapshot.tickers).length} stocks`);
    for (const [ticker, e] of sample) {
      console.log(`  ${ticker.padEnd(6)} overall ${String(e.overall).padStart(3)} bull30d ${String(e.bull["30d"] ?? "-").padStart(3)}  ${e.verdict}`);
    }
    return;
  }

  const { FIREBASE_SERVICE_ACCOUNT } = process.env;
  if (!FIREBASE_SERVICE_ACCOUNT) {
    console.log("NOTICE: FIREBASE_SERVICE_ACCOUNT is not set; skipping the history snapshot.");
    return;
  }

  initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const ref = getFirestore().collection("history").doc(day);

  // A transaction so two builds finishing at once cannot each overwrite the other's sample.
  const folded = await getFirestore().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    const next = foldDay(existing.exists ? existing.data() : null, snapshot, market.generatedAt, day);
    tx.set(ref, next);
    return next;
  });

  const samples = Object.values(folded.tickers)[0]?.n ?? 1;
  console.log(`Recorded ${Object.keys(snapshot.tickers).length} stocks into history/${day} (build ${samples} of the day, regime ${folded.regime}).`);
}

await main();
