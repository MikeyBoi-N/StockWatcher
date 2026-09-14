/**
 * Emails each opted-in user what changed on their watchlist between the previously deployed data build and
 * the new data/market.json. One email per user per build, only when something changed.
 *
 * Usage: node scripts/send_alerts.mjs <previous-market.json> [--dry-run]
 *
 * Env:
 *   FIREBASE_SERVICE_ACCOUNT  service account key JSON (reads users/*, which firestore.rules keeps private)
 *   GMAIL_USER, GMAIL_APP_PASSWORD  the Gmail account alerts are sent from (not needed with --dry-run)
 *   SITE_URL  link back to the dashboard
 *
 * Without the Firebase or Gmail settings the script logs a notice and exits cleanly, so the build still passes.
 * Logs never include email addresses: Actions logs on a public repository are public.
 */
import { existsSync, readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import { alertsForUser, normalizeAlertPrefs, summarizeSnapshot } from "../js/alerts.js";

const CURRENT_FILE = new URL("../data/market.json", import.meta.url);

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, ch => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
));

function renderEmail(alerts, generatedAt, siteUrl) {
  const tickers = [...new Set(alerts.map(a => a.ticker).filter(Boolean))];
  const subject = `StockWatcher: ${alerts.length} alert${alerts.length === 1 ? "" : "s"}${tickers.length ? ` (${tickers.slice(0, 4).join(", ")}${tickers.length > 4 ? ", …" : ""})` : ""}`;
  const heading = (a) => a.ticker ? `${a.ticker} (${a.name})` : "Market";
  const built = new Date(generatedAt).toUTCString();
  const settings = `${siteUrl}#alerts`;

  const text = [
    ...alerts.map(a => `${heading(a)}\n  ${a.message}`),
    "",
    `Data built ${built}. Research only, not investment advice.`,
    `Dashboard: ${siteUrl}`,
    `Change or turn off alerts: ${settings}`
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; font-size:14px; color:#1a1a1a; max-width:560px;">
      ${alerts.map(a => `
        <div style="padding:10px 0; border-bottom:1px solid #e5e5e5;">
          <div style="font-weight:600;">${escapeHtml(heading(a))}</div>
          <div>${escapeHtml(a.message)}</div>
        </div>`).join("")}
      <p style="font-size:12px; color:#666;">Data built ${escapeHtml(built)}. Research only, not investment advice.</p>
      <p style="font-size:12px;"><a href="${escapeHtml(siteUrl)}">Open dashboard</a> · <a href="${escapeHtml(settings)}">Change or turn off alerts</a></p>
    </div>`;
  return { subject, text, html };
}

async function main() {
  const [previousPath, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  if (!previousPath || !existsSync(previousPath)) {
    console.log("No previous data build to compare against; skipping alerts.");
    return;
  }

  const prev = summarizeSnapshot(JSON.parse(readFileSync(previousPath, "utf8")));
  const cur = summarizeSnapshot(JSON.parse(readFileSync(CURRENT_FILE, "utf8")));
  if (!(Date.parse(cur.generatedAt) > Date.parse(prev.generatedAt))) {
    console.log(`This build (${cur.generatedAt}) is not newer than the deployed one (${prev.generatedAt}); skipping alerts.`);
    return;
  }

  const { FIREBASE_SERVICE_ACCOUNT, GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  const siteUrl = process.env.SITE_URL || "https://mikeyboi-n.github.io/StockWatcher/";
  if (!FIREBASE_SERVICE_ACCOUNT || (!dryRun && !(GMAIL_USER && GMAIL_APP_PASSWORD))) {
    console.log("NOTICE: FIREBASE_SERVICE_ACCOUNT, GMAIL_USER or GMAIL_APP_PASSWORD is not set; skipping alerts.");
    return;
  }

  initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
  const auth = getAuth();
  const users = await getFirestore().collection("users").where("alerts.enabled", "==", true).get();
  const transporter = dryRun ? null : nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });

  let sent = 0, unverified = 0, failed = 0;
  for (const doc of users.docs) {
    const data = doc.data();
    const alerts = alertsForUser(prev, cur, normalizeAlertPrefs(data.alerts), Array.isArray(data.watchlist) ? data.watchlist : []);
    if (!alerts.length) continue;

    // The profile's `email` field is client-written, so send only to the verified address on the auth account.
    let account;
    try {
      account = await auth.getUser(doc.id);
    } catch (err) {
      console.warn(`Skipping a profile with no auth account (${err.code})`);
      continue;
    }
    if (!account.email || !account.emailVerified) {
      unverified++;
      continue;
    }

    const email = renderEmail(alerts, cur.generatedAt, siteUrl);
    if (dryRun) {
      console.log(`--- ${email.subject}\n${email.text}\n`);
      sent++;
      continue;
    }
    try {
      await transporter.sendMail({ from: `StockWatcher <${GMAIL_USER}>`, to: account.email, ...email });
      sent++;
    } catch (err) {
      failed++;
      console.error(`Send failed: ${err.message}`);
    }
  }

  console.log(`${users.size} user(s) with alerts on: ${sent} ${dryRun ? "previewed" : "emailed"}, ${unverified} skipped (unverified email), ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

await main();
