/**
 * Records what the scoring engine says about every tracked stock into Firestore as one snapshot per data build
 * (`snapshots/{id}` for the readings, `snapshotInputs/{id}` for the raw inputs; see js/history.js), so the
 * Historical view can show how a recommendation changed and whether it worked.
 *
 * The id is the build's own timestamp, so each build is stored exactly once: recording the same build again is
 * refused rather than counted twice. Both documents are written in one batch, so a snapshot never exists without
 * its inputs. Stored snapshots live in Firestore, outside the site, and no deploy touches them.
 *
 * Usage: node scripts/record_history.mjs [--dry-run] [--force]
 *   --dry-run  print the snapshot instead of writing it
 *   --force    record even when the data build is old (it is skipped by default: when every source fails,
 *              build_market_data.py leaves the committed snapshot in place, which can be days old)
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service account key JSON (the Admin SDK bypasses firestore.rules, which keep both
 *                             collections read-only for everyone else)
 *
 * Without the Firebase setting the script logs a notice and exits cleanly, so the build still passes.
 */
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { buildMarketContext, evaluateAsset } from "../js/engine.js";
import { snapshotDocuments, snapshotFromEvaluations } from "../js/history.js";

const MARKET_FILE = new URL("../data/market.json", import.meta.url);
// A fresh build finishes minutes before this runs; anything this old is the committed fallback, not today's data.
const MAX_BUILD_AGE_HOURS = 6;
const ALREADY_EXISTS = 6;

/** Writes one build's two documents together. Returns false when that build is already stored. */
async function createSnapshot(db, { id, snapshot, inputs }) {
  const batch = db.batch();
  batch.create(db.collection("snapshots").doc(id), snapshot);
  batch.create(db.collection("snapshotInputs").doc(id), inputs);
  try {
    await batch.commit();
    return true;
  } catch (err) {
    if (err.code === ALREADY_EXISTS) return false;
    throw err;
  }
}

/**
 * Days recorded before snapshots were kept per build sit in history/{day} as a running mean of that day's builds.
 * They are real readings, so each is carried over as one snapshot at its last build's time, its readings still
 * marked with how many builds they average (`n`). Safe to run every time: a day already carried over is skipped.
 */
async function carryOverLegacyDays(db) {
  const legacy = await db.collection("history").get();
  let carried = 0;
  for (const doc of legacy.docs) {
    const day = doc.data();
    if (!day.generatedAt || !day.tickers) continue;
    if (await createSnapshot(db, snapshotDocuments(day, day.generatedAt))) carried++;
  }
  if (carried) console.log(`Carried ${carried} day(s) over from the old per-day history collection.`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const market = JSON.parse(readFileSync(MARKET_FILE, "utf8"));

  const primary = new Set(market.universe?.primary ?? []);
  const records = Object.values(market.stocks ?? {}).map(r => ({ ...r, isPrimary: primary.has(r.ticker) }));
  if (!records.length) {
    console.log("No stocks in the data build; nothing to record.");
    return;
  }

  const ageHours = (Date.now() - Date.parse(market.generatedAt)) / 36e5;
  if (ageHours > MAX_BUILD_AGE_HOURS && !args.includes("--force") && !dryRun) {
    console.log(`NOTICE: the data build is ${Math.round(ageHours)} hours old (${market.generatedAt}), so this run's sources failed; skipping the snapshot.`);
    return;
  }

  const context = buildMarketContext(records, market.sectors);
  const snapshot = snapshotFromEvaluations(records.map(item => evaluateAsset(item, context)), context);
  const docs = snapshotDocuments(snapshot, market.generatedAt);

  if (dryRun) {
    const tickers = Object.entries(docs.snapshot.tickers);
    console.log(`snapshots/${docs.id} (market day ${docs.snapshot.day}, ${snapshot.regime}): ${tickers.length} stocks, ${Object.keys(docs.inputs.tickers[tickers[0][0]]).length} inputs each`);
    for (const [ticker, e] of tickers.slice(0, 5)) {
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
  const db = getFirestore();
  await carryOverLegacyDays(db);

  const stocks = Object.keys(docs.snapshot.tickers).length;
  if (await createSnapshot(db, docs)) {
    console.log(`Recorded snapshots/${docs.id}: ${stocks} stocks, market day ${docs.snapshot.day}, regime ${snapshot.regime}.`);
  } else {
    console.log(`snapshots/${docs.id} is already recorded; left it unchanged.`);
  }
}

await main();
