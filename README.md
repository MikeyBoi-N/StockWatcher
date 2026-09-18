# StockWatcher

> **An account-based stock and options research assistant that enforces institutional discipline, patience, and anti-FOMO skepticism.**

[![Build & Deploy](https://github.com/MikeyBoi-N/StockWatcher/actions/workflows/deploy.yml/badge.svg)](https://github.com/MikeyBoi-N/StockWatcher/actions/workflows/deploy.yml)

**Live Web App:** [https://mikeyboi-n.github.io/StockWatcher/](https://mikeyboi-n.github.io/StockWatcher/)

---

## How to Enable GitHub Pages

Once pushed, enable GitHub Pages in your repository settings:

1. Go to your repository on GitHub: **[MikeyBoi-N/StockWatcher](https://github.com/MikeyBoi-N/StockWatcher)**.
2. Click on **Settings** (top navigation tab).
3. In the left sidebar under *Code and automation*, click on **Pages**.
4. Under **Build and deployment**:
   - **Option A (Automated with GitHub Actions - Recommended):** Set **Source** to `GitHub Actions`. The bundled workflow in `.github/workflows/deploy.yml` will automatically deploy the site on every push to `main`.
   - **Option B (Direct Branch):** Set **Source** to `Deploy from a branch`, select branch `main`, folder `/ (root)`, and click **Save**.
5. Your live site will be accessible at:
   ```
   https://mikeyboi-n.github.io/StockWatcher/
   ```

---

## Firebase Setup (User Accounts & Saved Watchlists)

Accounts use **Firebase Authentication** (Google or email/password) and each user's watchlist is stored in **Cloud Firestore**. The free Spark plan is enough. Until this is done, the site runs in guest-only mode.

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com/).
2. **Authentication** → *Get started* → *Sign-in method* → enable **Email/Password** and **Google**.
3. **Authentication** → *Settings* → *Authorized domains* → add `mikeyboi-n.github.io`.
4. **Firestore Database** → *Create database* (production mode, any region).
5. **Firestore Database** → *Rules* → paste the contents of [`firestore.rules`](firestore.rules) → *Publish* (or `firebase deploy --only firestore:rules`).
6. **Project settings** → *General* → *Your apps* → add a **Web app**, copy its config values into [`firebase-config.js`](firebase-config.js), commit, and push.

The web config values are public identifiers, not secrets; `firestore.rules` is what restricts each user to their own `users/{uid}` document.

---

## Email Alerts

Signed-in users turn alerts on from the account menu (**Email alerts**) and choose what triggers them for stocks on their watchlist:

- Enters the buy zone
- Drops to avoid
- A chosen score (Overall, Quality, Trend, Entry or Trade) reaches a chosen threshold
- Price falls below entry support (the trade invalidation level)
- Earnings within a chosen number of days
- Files a material 8-K (anything but the routine results release)
- Market regime changes

After each data build, [`scripts/send_alerts.mjs`](scripts/send_alerts.mjs) scores the new `data/market.json` and the copy the site was showing with the same engine ([`js/alerts.js`](js/alerts.js)), and sends each user one email listing what changed. Alerts fire on transitions, so a stock that stays in the buy zone is reported once. The first build after a scoring-model change is skipped, so a model change is never reported as a market move. Emails go only to the verified address on the Firebase Auth account (Google sign-ins are verified; email/password accounts get a "Send verification email" button in the dialog).

**Limits:** checks happen only when the data builds (3x per weekday), so a price that dips below support and recovers between builds is missed. A stock hovering at a threshold can alert on consecutive builds. Gmail allows about 500 emails a day.

### Alert setup
1. **Firebase console → Project settings → Service accounts → Generate new private key.** In GitHub, **Settings → Secrets and variables → Actions → Secrets → New repository secret:** `FIREBASE_SERVICE_ACCOUNT` = the entire JSON file. Then delete the downloaded file.
2. **Google Account → Security:** turn on 2-Step Verification, then create an **App password**. Add secrets `GMAIL_USER` (the full Gmail address) and `GMAIL_APP_PASSWORD` (the 16-character app password).
3. Nothing else: the deploy workflow publishes [`firestore.rules`](firestore.rules) with the same service account whenever it changes ([`scripts/deploy_firestore_rules.mjs`](scripts/deploy_firestore_rules.mjs)).

Until the secrets exist, the alert step logs a notice and the build still passes.

---

## Real Market Data

Every number on the dashboard comes from a real source. A GitHub Actions job ([`scripts/build_market_data.py`](scripts/build_market_data.py)) runs every 4 hours on weekdays around US market hours, writes `data/market.json`, and redeploys the site. The page shows when the data was built and flags it if it is more than 4 days old.

| Data | Source | Notes |
|---|---|---|
| Daily price history (5 years), volume | Yahoo Finance chart API, Nasdaq.com fallback | Moving averages, RSI, realized volatility, 52-week and 60-session ranges, structural and entry support, resistance and 5-day/1/3/6/12-month returns are computed from these bars |
| Sector benchmarks | Yahoo Finance chart API (SPDR sector ETFs: XLK, XLF, XLV, XLY, XLP, XLE, XLI, XLU, XLRE, XLB, XLC) | 3-month return vs SPY sets each stock's sector regime |
| Revenue, operating margin, earnings, free cash flow, leverage, EPS | SEC EDGAR XBRL filings (10-K/10-Q/20-F) | Trailing twelve months; newly registered companies fall back to latest quarter vs the same quarter a year earlier |
| Forward (next-twelve-month) EPS, PEG, earnings date, estimate revisions, 1y target, sector | Nasdaq.com (Zacks consensus) | Earnings dates are marked when estimated |
| Options chain: bid/ask, IV, delta, theta, open interest | Cboe delayed quotes (15-minute delay) | ATM call at the monthly expiration nearest 45-60 DTE |
| Latest quarter (revenue, operating income, net income vs a year earlier), buybacks and dividends | SEC EDGAR XBRL filings | Quarters derived the same way as the trailing figures |
| 8-K events (restructuring, new debt, leadership changes, impairments, …) | SEC EDGAR filing index | Labeled from the 8-K item numbers the company selected; routine items (exhibits, Reg FD, vote results) are dropped |
| Headlines (last 7 days) | Yahoo Finance RSS | Only headlines naming the ticker or company; tone is a keyword match on event words, not analysis |

Each build cross-checks price and the 52-week range across sources and logs any disagreement over 2%. A build that loses SPY, QQQ or more than 20% of the core universe does not overwrite the previous data.

Stocks users add to their watchlists are recorded in the public Firestore `tickerRequests` collection and included in the next build (up to 250 tickers). Until then they appear under "Market data pending".

**Caveats:** Yahoo, Nasdaq and Cboe endpoints are unofficial, can rate-limit or change without notice, and their terms restrict redistribution. This project is for personal research, not investment advice.

### Data build setup
1. **Settings → Secrets and variables → Actions → Variables → New repository variable:** `SEC_USER_AGENT` = `StockWatcher your-email@example.com`. SEC requires a contact email in the User-Agent; without it, fundamentals from filings are skipped.
2. Deploy the Firestore rules (they include the `tickerRequests` collection): in Cloud Shell or locally, `firebase deploy --only firestore:rules`.
3. GitHub pauses scheduled workflows after 60 days without repository activity; re-enable it from the Actions tab if that happens.

---

## Features

### 1. User Accounts & Personalized Watchlists
- **Account Profiles:** Continue with Google, or create an account with email and password and reset it by email (Firebase Authentication).
- **Personalized Watchlist:** Choose which stocks your account tracks from the core universe in [`data/universe.json`](data/universe.json): `SPY`, `QQQ`, `MSFT`, `NVDA`, `XOM`, `SNDK`, `GOOGL`, `AMZN`, `META`, `AVGO`, `TSM` (primary), plus 41 secondary names across sectors: `JPM`, `COST`, `AMD`, `AAPL`, `LLY`, `TSLA`, `PLTR`, the `IWM` and `DIA` index ETFs, software and internet (`ORCL`, `CRM`, `ADBE`, `NFLX`, `UBER`, `COIN`), semiconductors (`MU`, `QCOM`, `AMAT`, `INTC`), financials (`BRK.B`, `V`, `MA`, `BAC`, `GS`), healthcare (`UNH`, `JNJ`, `MRK`, `ABBV`), consumer (`WMT`, `PG`, `KO`, `PEP`, `HD`, `MCD`, `NKE`, `DIS`) and industrials and energy (`CVX`, `CAT`, `GE`, `LMT`, `BA`).
- **Add Real Stocks:** Search ~11,800 US-listed stocks and ETFs (NASDAQ, NYSE, NYSE American, NYSE Arca, Cboe BZX, IEX) by ticker or company name, with a mandatory written justification (*"Why it deserves attention"*). The stock is scored once the next data build includes it.
- **Synced Across Devices:** Your watchlist, added stocks and theses are saved to your account in Cloud Firestore.

### 2. Overview
- Market regime (SPY and QQQ vs their moving averages), SPY and QQQ prices with daily change, the best idea, and verdict counts.
- When prices were last updated and when the data was built.

### 3. Four-Score Rules Engine ([`js/engine.js`](js/engine.js))
A single score blurs "is this a great company" with "is this a good price", so the engine scores four separate questions from 0 to 100. Each score is a sum of named factors shown in the detail view; a missing input scores its factor's midpoint and is listed as a data gap.
- **Quality (is it a strong business?):** revenue growth (20), operating margin (20), margin trend (10), earnings growth (15), free cash flow (10), balance sheet (10, skipped for financials), analyst estimate revisions (15). ETFs have no Quality score.
- **Trend (is it in a healthy uptrend?):** price vs 200-day SMA (20), 50-day vs 200-day (15), price vs 50-day (10), 3-month (15) and 12-month (15) return vs SPY, RSI momentum (10), market regime (15). Being far above the averages does not hurt Trend.
- **Entry (is today's price a good buy point?):** distance above entry support in weekly moves (35), stretch above the 50-day in monthly moves (20), stretch above the 200-day (15), RSI (15), room to resistance (15). A "typical move" comes from 30-day realized volatility, so a 5% gap means more for a calm stock than a volatile one.
- **Trade (is the risk/reward worth it?):** reward vs risk to the stop (30), valuation label (20), PEG (10), analyst target (10), earnings timing (15), options liquidity and IV cost (15).
- **Overall** = 30% Quality + 25% Trend + 25% Entry + 20% Trade (reweighted without Quality for ETFs). It sorts the table and picks the best idea; it never decides the verdict.

**Two support levels.** *Structural support* is the one-year swing low (lowest low within ±15 sessions, clustered within 1.5%): where the longer-term thesis breaks. *Entry support* is the nearest level at least 1% below price and within about one month's typical move (bounded to 4–25%): the 50-day SMA, the 200-day SMA, or a 3-month minor swing low (±5 sessions). It is the trade stop, and Entry, reward/risk and the preferred entry zone are measured against it. When nothing qualifies, entry support falls back to structural support.

**Verdicts** come from the four scores, so they say what is missing:
- **Buy zone:** Entry 75+, Trend 60+, Quality 60+, Trade 60+, reward/risk at least 1.5 : 1, chase risk not High, no earnings inside 14 days.
- **Strong asset, poor entry / poor risk/reward / wait for earnings:** Quality 65+ (Trend 65+ for ETFs) and Trend 55+, but not a buy yet.
- **Watch:** everything else.
- **Avoid, broken trend** (Trend under 35) or **Avoid, weak business** (Quality under 40).

**Diagnostics** in the detail view label each stock in four sections:
- *Market context:* market regime, sector regime (sector ETF vs SPY), relative strength, market breadth (share of tracked stocks above their 50-day now vs a month ago) and volatility regime (SPY 30-day realized volatility).
- *Asset quality:* fundamental quality, earnings trend (latest quarter vs trailing twelve months), revenue growth, margin quality, valuation (Cheap / Fair / Expensive / Extreme from forward P/E vs its 5-year average), valuation vs growth (PEG), analyst revision trend.
- *Technical state:* primary and short-term trend, momentum (1-month return vs the 3-month pace), RSI state, which averages price is above, distance to support and resistance, breakout status (vs the prior 60-session range) and pullback depth.
- *Entry diagnostics:* entry quality, entry type (Pullback, Breakout, Continuation, Reversal, Mean Reversion), risk/reward, upside to resistance, downside to support, distance from the preferred entry, chase risk, invalidation level, trigger (e.g. *Break & hold > $553.72*) and preferred entry zone.

The thresholds are starting points chosen by hand, not fitted to past returns.

### 4. Options vs Shares Engine
True IV Rank needs a year of implied-volatility history that no free source provides, so the engine compares at-the-money implied volatility with the stock's 30-day realized volatility:
- `IV / realized ≤ 0.9`: options cheap → **Long Call** (monthly expiration nearest 45–60 DTE) or **Call Debit Spread**.
- `0.9 – 1.3`: moderate → **Vertical Call Debit Spread**.
- `≥ 1.3`: options expensive → **Cash-Secured Put** at support or **Shares**.
- Illiquid chains (open interest under 500 or bid/ask spread over 6%) → **Shares**; earnings inside 14 days → **Shares only**; not in the buy zone → **WAIT**.

### 5. Benchmark Table
One sortable table ranks every stock in the current view (watchlist, all, primary, or alerts; the historical view is described below):
- **Ranking:** rank, verdict, Overall and the four scores, the next step each stock needs, warnings (extension, earnings inside 14 days, weak fundamentals, stretched valuation, illiquid options), what the stock stands out in, and what's happening.
- **Entry:** entry type, reward/risk, preferred entry zone, distance from it, chase risk, entry support, distance to the stop, structural support.
- **Price and trend:** price, daily change, 3- and 12-month return vs SPY, distance from the 50d and 200d SMAs, RSI, resistance, 52-week range.
- **Fundamentals and valuation:** revenue growth, operating margin, FCF yield, net debt/EBITDA, trajectory, valuation label, forward/trailing/5-year P/E, PEG, market cap.
- **Events:** days to earnings, analyst EPS revisions, 1-year target upside.
- **Options:** vehicle, expiration, ATM strike, implied volatility, IV vs realized volatility, delta, theta, expected move, open interest, bid/ask spread.

**Peer benchmarks ([`js/benchmarks.js`](js/benchmarks.js)):** every stock is ranked against all tracked stocks on each of the four scores and on revenue growth, operating margin, leverage, FCF yield, forward P/E, PEG, EPS revisions, analyst upside and 3- and 12-month return vs SPY. Cells in the top 10% (at least the top 3) are tinted green, and the "Stands out in" column lists those measures, so a stock with a lower Overall still shows where it leads. A tie only counts as leading when the tied group is small. Peer ranks are display-only; headlines and 8-K events never change any score.

Click any column to sort (missing values always sort last) and any row for the detail view: the verdict and all five scores, a card per score listing every factor's points, entry diagnostics, market/quality/technical diagnostics, a price chart with SMAs, entry support and structural support, every metric colored green (favorable), yellow (in between) or red (unfavorable) ([`js/grades.js`](js/grades.js)), fact/interpretation/speculation tagging, the bear/bull evaluation, and each score's rank among tracked stocks.

**Bear/bull evaluation:** pick 24h, 5d, 30d, 6m or 12m. The meter is price action only, looking back: 50% the period's return in units of the stock's typical move for that period, 30% its return vs SPY in the same units, 20% where price sits against the matching trend line (20-day for 5d, 50-day for 30d, 200-day for 6m and 12m), each capped at ±2.5 typical moves. One word describes it: Bearish, Weak, Neutral, Firm or Bullish. It is not a forecast and not part of any score. The bear case and both invalidation levels (trade and thesis) sit below it. Stocks you added that are waiting for their first data build appear as "Data pending" rows.

### 6. What's Happening ([`js/developments.js`](js/developments.js))
Each table row carries a one-line summary, with the full version in the detail view. No language model or text interpretation is involved; every statement comes from a number or a form item:
- **Latest quarter:** revenue and net income or loss versus the same quarter a year earlier, e.g. *"Quarter ended Jun 27: revenue $16.1B (+25% YoY), net loss $11.0B (was a $2.9B loss)."*
- **Capital returns:** buybacks and dividends over the trailing twelve months.
- **What the company did:** 8-K events from the last 120 days, linked to the filing, negative ones (restructuring, impairment, restatement, delisting notice) first.
- **Headlines:** up to six from the last week that name the company, marked + or − when they contain event words ("downgrade", "raises guidance", "lawsuit"). Most headlines are opinion pieces and stay neutral.

### 7. Recommendation History ([`js/history.js`](js/history.js))
The **Historical** view is a second table: one row per stock and one column per snapshot, newest first. Each cell shows what the engine said at that build and the Overall score it gave, so you can check whether a reading held up. **Columns** switches between every build (timed in New York time) and a daily average of each market day's builds; **Show** switches the cell between the bear/bull word, the verdict and each of the five scores; **Period** picks the bear/bull horizon; **Days** sets how far back to load. Hovering a cell gives the verdict, all five scores, the price, and what the price did over the following 5 and 30 sessions. The **Outcome** columns on the left are the scoreboard: price change since the first snapshot, and the average change over the 5 and 30 sessions after each recorded day, measured from that day's last snapshot (the evening build runs after the close; weekend builds are not sessions).

Every data build - about every 4 hours on weekdays - is stored as its own snapshot, keyed by the build's timestamp, so the same build can never be recorded twice and nothing is averaged away when it is written; the daily view averages when it reads. Each snapshot also stores the raw inputs the engine read - prices, SMAs, RSI, realized volatility, returns, fundamentals, valuation, catalysts, options and the derived levels - not just the scores, because the scoring rules will be retuned and **none of this can be backfilled**. Download CSV in this view writes one row per stock per snapshot with the market regime, every input, every score and the forward returns, which is the file to tune or train a model on.

[`scripts/record_history.mjs`](scripts/record_history.mjs) writes each build into Firestore using the same engine the page uses: `snapshots/{id}` holds the readings the table shows, and `snapshotInputs/{id}` the raw inputs, which only the export downloads. Both are public-read and written only by the build's service account (see [`firestore.rules`](firestore.rules)), so the view works signed out. The history lives in Firestore rather than in the site, so deploys never touch it. A build whose data sources all failed deploys the committed `data/market.json`, which can be days old, so the recorder skips any build more than 6 hours old. GitHub starts scheduled runs late, often by 1-3 hours, so snapshot times drift; each one is labelled with when its data was actually built.

Queries filter and sort on the snapshot's stored `at` timestamp. Keep it that way: sorting by document id in descending order needs a Firestore composite index this project does not have, and the query fails without one.

### 8. Utilities
- **Download CSV:** the current view with its search and sort, one column per table column plus the company name; percentages are plain numbers (12.5 means 12.5%). In the Historical view it is written long instead - one row per stock per snapshot.
- **Stress tests:** simulated -8% tech pullback, implied volatility x1.6, or +8% rally applied to the real data and labeled as simulated.
- **Copy report:** markdown export of the current view.

---

## Local Development / Testing

To test locally without installing dependencies:
1. Clone the repo:
   ```bash
   git clone https://github.com/MikeyBoi-N/StockWatcher.git
   ```
2. Serve the folder (opening `index.html` directly won't load modules or the symbol list):
   ```bash
   python -m http.server 8000
   ```
3. Open [http://localhost:8000](http://localhost:8000). `localhost` is an authorized Firebase domain by default.

### Building market data and running tests locally
```bash
SEC_USER_AGENT="StockWatcher you@example.com" python scripts/build_market_data.py   # core + requested tickers
python scripts/build_market_data.py --only AAPL,SPY                                  # quick partial build
python -m pip install pytest && python -m pytest tests                               # data pipeline tests
npm test                                                                             # scoring engine, alert, summary, benchmark and history tests
```

To see the history snapshot for the current `data/market.json` without writing it:
```bash
node scripts/record_history.mjs --dry-run
```

To preview alert emails without sending (needs `npm install` and the service account key):
```bash
curl -fsSL https://mikeyboi-n.github.io/StockWatcher/data/market.json -o /tmp/previous.json
FIREBASE_SERVICE_ACCOUNT="$(cat path/to/key.json)" node scripts/send_alerts.mjs /tmp/previous.json --dry-run
```

### Refreshing the symbol list
`data/symbols.json` is generated from Nasdaq Trader's public symbol directories. The deploy workflow refreshes it on every run; to refresh it locally:
```bash
python scripts/fetch_symbols.py
```

---

## License
MIT License. Built for disciplined, patient traders.
