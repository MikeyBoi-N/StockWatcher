# StockWatcher 📈

> **A deterministic, account-based stock and options research assistant that enforces institutional discipline, patience, and anti-FOMO skepticism.**

[![Deploy to GitHub Pages](https://github.com/MikeyBoi-N/StockWatcher/actions/workflows/deploy.yml/badge.svg)](https://github.com/MikeyBoi-N/StockWatcher/actions/workflows/deploy.yml)

**Live Web App:** [https://mikeyboi-n.github.io/StockWatcher/](https://mikeyboi-n.github.io/StockWatcher/)

---

## 🚀 How to Enable GitHub Pages

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

## ✨ Features

### 1. User Accounts & Personalized Watchlists
- **Account Profiles:** Sign up, log in, or use the 1-click Demo Account (`demo_trader`).
- **Personalized Watchlist:** Choose exactly which stocks your account tracks from the institutional library (`SPY`, `QQQ`, `MSFT`, `NVDA`, `SPCX`, `XOM`, `SNDK`, `GOOGL`, `AMZN`, `META`, `AVGO`, `TSM`, `JPM`, `COST`, `AMD`, `AAPL`, `LLY`, `TSLA`, `PLTR`).
- **Custom Candidate Ingestion:** Add any custom stock with full technical levels, fundamentals, and a mandatory written justification (*"Why it deserves attention"*).
- **Persistent Sessions:** Your selected watchlist and preferences automatically save and persist across visits.

### 2. Large "RUN MARKET SCAN" Button & Diagnostic Terminal
- A prominent, tactile **RUN MARKET SCAN** button audits your active watchlist in `< 200ms`.
- Real-time diagnostic terminal checks moving averages, audits balance sheet leverage, scans options liquidity, and tests support channels.
- Active **Anti-FOMO Shield** status counter reinforces that the default answer is **WAIT**.

### 3. Multi-Pillar Deterministic Quantitative Rules Engine
Calculates a disciplined **Opportunity Score (0–100)**:
- **Technicals (0–30 pts):** 20d, 50d, and 200d SMAs; extension penalties; distance to major structural support; 14-day RSI; drawdown tier alerts (`-10%`, `-15%`, `-20%`, `-25%+`).
- **Fundamentals (0–25 pts):** Revenue & EPS growth, operating margins, leverage (`Net Debt / EBITDA`), and business trajectory (*Getting Stronger* vs *Getting Weaker*).
- **Valuation (0–20 pts):** Forward P/E vs 5-year average; PEG ratio; Free Cash Flow yield.
- **Catalysts & Event Risk (0–15 pts):** Binary earnings risk warning (`< 14 days`); secular tailwinds (AI capex, memory storage cycle, orbital launch cadence, crude trends).
- **Market Regime Alignment (0–10 pts):** Multi-trend regime of `SPY` and `QQQ` relative to their 50d and 200d SMAs (*Bullish, Neutral, Cautious, Bearish*).

### 4. Options vs Shares Engine
- **Implied Volatility Rank (IV Rank):**
  - `IV Rank < 30%`: Options underpriced $\rightarrow$ **Long Calls** (45–60 DTE, `~0.50` Delta) or **Call Debit Spreads**.
  - `IV Rank 30%–65%`: Moderate IV $\rightarrow$ **Vertical Call Debit Spreads** to neutralize theta decay.
  - `IV Rank > 65%`: Options expensive $\rightarrow$ Recommends **Cash-Secured Puts** at support or **Shares**.
- Strictly enforces `45–60` DTE, avoids short-dated `< 14` DTE lottery tickets, and warns against post-earnings volatility crush.

### 5. Structured Research Outputs
1. **MARKET CONDITIONS:** SPY & QQQ moving average diagnostics and regime.
2. **BEST OPPORTUNITY TODAY:** Top-ranking idea from your monitored watchlist (or honest *"WAIT — No asset qualifies today"* banner).
3. **TOP WATCHLIST OPPORTUNITIES:** Ranked cards with support, resistance, and preferred vehicle.
4. **NOT READY YET:** Patient watchlist with exact conditional pullback price triggers.
5. **AVOID / HIGH RISK:** Flags overextended or valuation-strained tickers.
6. **WHAT I WOULD WATCH NEXT:** Actionable price triggers and upcoming event radar.
7. **THE BEAR CASE:** Strongest counter-argument and exact thesis invalidation level for every candidate.
8. **EPISTEMIC DISCIPLINE:** Explicit color-coded tagging for **FACT**, **INTERPRETATION**, and **SPECULATION**.

### 6. Interactive Visuals & Utilities
- **Interactive SVG Charts:** Detailed modal charts showing 20d/50d/200d SMAs and horizontal support channels.
- **Stress-Test Scenarios:** One-click simulation of `-8%` Tech Pullback, High IV Spike, or Extended Rally.
- **Copy Journal Report:** One-click markdown export formatted for trading journals.

---

## 🛠 Local Development / Testing

To test locally without installing dependencies:
1. Clone the repo:
   ```bash
   git clone https://github.com/MikeyBoi-N/StockWatcher.git
   ```
2. Double-click `index.html` to open it in any web browser!

---

## 📜 License
MIT License. Built for disciplined, patient traders.
