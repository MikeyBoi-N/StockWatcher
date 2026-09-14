# StockWatcher

> **A deterministic, account-based stock and options research assistant that enforces institutional discipline, patience, and anti-FOMO skepticism.**

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

## Real Market Data

Every number on the dashboard comes from a real source. A GitHub Actions job ([`scripts/build_market_data.py`](scripts/build_market_data.py)) runs every 4 hours on weekdays around US market hours, writes `data/market.json`, and redeploys the site. The page shows when the data was built and flags it if it is more than 4 days old.

| Data | Source | Notes |
|---|---|---|
| Daily price history (5 years), volume | Yahoo Finance chart API, Nasdaq.com fallback | Moving averages, RSI, realized volatility, 52-week range and support/resistance are computed from these bars |
| Revenue, operating margin, earnings, free cash flow, leverage, EPS | SEC EDGAR XBRL filings (10-K/10-Q/20-F) | Trailing twelve months; newly registered companies fall back to latest quarter vs the same quarter a year earlier |
| Forward (next-twelve-month) EPS, PEG, earnings date, estimate revisions, 1y target, sector | Nasdaq.com (Zacks consensus) | Earnings dates are marked when estimated |
| Options chain: bid/ask, IV, delta, theta, open interest | Cboe delayed quotes (15-minute delay) | ATM call at the monthly expiration nearest 45-60 DTE |

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
- **Personalized Watchlist:** Choose which stocks your account tracks from the core universe in [`data/universe.json`](data/universe.json): `SPY`, `QQQ`, `MSFT`, `NVDA`, `XOM`, `SNDK`, `GOOGL`, `AMZN`, `META`, `AVGO`, `TSM` (primary) and `JPM`, `COST`, `AMD`, `AAPL`, `LLY`, `TSLA`, `PLTR`.
- **Add Real Stocks:** Search ~11,800 US-listed stocks and ETFs (NASDAQ, NYSE, NYSE American, NYSE Arca, Cboe BZX, IEX) by ticker or company name, with a mandatory written justification (*"Why it deserves attention"*). The stock is scored once the next data build includes it.
- **Synced Across Devices:** Your watchlist, added stocks and theses are saved to your account in Cloud Firestore.

### 2. Overview
- Market regime (SPY and QQQ vs their moving averages), SPY and QQQ prices with daily change, the best idea, and verdict counts.
- When prices were last updated and when the data was built.

### 3. Multi-Pillar Deterministic Rules Engine ([`js/engine.js`](js/engine.js))
Calculates an **Opportunity Score (0–100)**. Missing inputs (ETFs have no fundamentals, new listings lack a 200-day history) score the pillar's neutral midpoint and are listed as data gaps.
- **Technicals (0–30):** price vs 20d/50d/200d SMAs; extension penalty above +12% vs 50d or +22% vs 200d; within 3.5% of major support; 14-day Wilder RSI. Major support/resistance are one-year swing points (lowest low / highest high within ±15 trading days), clustered within 1.5%.
- **Fundamentals (0–25):** revenue growth, operating margin, net debt/EBITDA (skipped for financials), negative free cash flow, and business trajectory (*Getting Stronger / Roughly Unchanged / Getting Weaker*, voted from revenue growth, margin change and earnings growth).
- **Valuation (0–20):** P/E vs the stock's own 5-year average (only when that average is between 5x and 60x), penalty above 60x, PEG ratio, free-cash-flow yield.
- **Catalysts & Event Risk (0–15):** earnings inside 14 days, net analyst EPS revisions over 4 weeks, analyst 1-year target vs price.
- **Market Regime (0–10):** SPY and QQQ vs their 50d and 200d SMAs (*Bullish, Neutral, Cautious, Bearish*).

Every stock lands in exactly one bucket: **Avoid** (score under 55 or extended), **Actionable** (score 70+, at major support, no earnings inside 14 days), or **Not Ready** (everything else). The **Best Opportunity** is the top actionable stock scoring 75+; otherwise the dashboard says WAIT.

### 4. Options vs Shares Engine
True IV Rank needs a year of implied-volatility history that no free source provides, so the engine compares at-the-money implied volatility with the stock's 30-day realized volatility:
- `IV / realized ≤ 0.9`: options cheap → **Long Call** (monthly expiration nearest 45–60 DTE) or **Call Debit Spread**.
- `0.9 – 1.3`: moderate → **Vertical Call Debit Spread**.
- `≥ 1.3`: options expensive → **Cash-Secured Put** at support or **Shares**.
- Illiquid chains (open interest under 500 or bid/ask spread over 6%) → **Shares**; earnings inside 14 days → **Shares only**; score under 70 → **WAIT**.

### 5. Benchmark Table
One sortable table ranks every stock in the current view (watchlist, all, primary, or alerts):
- **Ranking:** rank, verdict (actionable / not ready / avoid), Opportunity Score, the next step each stock needs, and warnings (extension, earnings inside 14 days, weak fundamentals, stretched valuation, illiquid options).
- **Score breakdown:** technicals, fundamentals, valuation, events and market regime points.
- **Price and trend:** price, daily change, distance from the 50d and 200d SMAs, RSI, support, distance to support, resistance, 52-week range.
- **Fundamentals and valuation:** revenue growth, operating margin, FCF yield, net debt/EBITDA, trend, forward/trailing/5-year P/E, PEG, market cap.
- **Events:** days to earnings, analyst EPS revisions, 1-year target upside.
- **Options:** vehicle, expiration, ATM strike, implied volatility, IV vs realized volatility, delta, theta, expected move, open interest, bid/ask spread.

Click any column to sort (missing values always sort last) and any row for the detail view: price chart with SMAs and support, every metric with its source and date, fact/interpretation/speculation tagging, the bear case and invalidation level, and the full score breakdown with data gaps. Stocks you added that are waiting for their first data build appear as "Data pending" rows.

### 6. Utilities
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
node --test tests/engine.test.mjs                                                    # scoring engine tests
```

### Refreshing the symbol list
`data/symbols.json` is generated from Nasdaq Trader's public symbol directories. The deploy workflow refreshes it on every run; to refresh it locally:
```bash
python scripts/fetch_symbols.py
```

---

## License
MIT License. Built for disciplined, patient traders.
