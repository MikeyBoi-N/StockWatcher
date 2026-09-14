/**
 * Publishes firestore.rules to the Firebase project, skipping the release when the live rules already match
 * (every release creates a stored ruleset, and projects are capped at 2,500).
 *
 * Env: FIREBASE_SERVICE_ACCOUNT (service account key JSON). Without it the script logs a notice and exits cleanly.
 */
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getSecurityRules } from "firebase-admin/security-rules";

const { FIREBASE_SERVICE_ACCOUNT } = process.env;
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.log("NOTICE: FIREBASE_SERVICE_ACCOUNT is not set; skipping Firestore rules deploy.");
  process.exit(0);
}

const source = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const rules = getSecurityRules();

const live = await rules.getFirestoreRuleset();
if (live.source.length === 1 && live.source[0].content === source) {
  console.log(`Firestore rules already match ${live.name}.`);
} else {
  const released = await rules.releaseFirestoreRulesetFromSource(source);
  console.log(`Released Firestore ruleset ${released.name}.`);
}
