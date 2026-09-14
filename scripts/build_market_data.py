"""
Build data/market.json: real market data for the core universe plus tickers users added to their watchlists.

Usage:
  SEC_USER_AGENT="Your Name you@example.com" python scripts/build_market_data.py [--only AAPL,SPY] [--skip-requests]

Without SEC_USER_AGENT, SEC fundamentals are skipped (SEC requires a contact email in the User-Agent).
The output file is only written when SPY, QQQ and at least 80% of the core universe succeed, so a bad run
never replaces good data.
"""
import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from market_data.http_client import FetchError, HttpClient
from market_data.indicators import technicals
from market_data.snapshot import build_stock_record, failed_checks
from market_data.sources import CboeOptions, NasdaqAnalyst, NasdaqHistory, Providers, SecEdgar, YahooChart, YahooNews

ROOT = Path(__file__).resolve().parent.parent
UNIVERSE_FILE = ROOT / "data" / "universe.json"
SYMBOLS_FILE = ROOT / "data" / "symbols.json"
OUTPUT_FILE = ROOT / "data" / "market.json"
FIREBASE_CONFIG_FILE = ROOT / "firebase-config.js"

REGIME_TICKERS = ("SPY", "QQQ")
MAX_TICKERS = 250
MIN_CORE_SUCCESS = 0.8
WORKERS = 4


def load_symbol_directory():
    data = json.loads(SYMBOLS_FILE.read_text(encoding="utf-8"))
    return {s: {"name": n, "exchange": ex, "etf": bool(etf)} for s, n, ex, etf in data["symbols"]}


def requested_tickers(http, directory):
    """Tickers users added, read from the public Firestore `tickerRequests` collection, newest first."""
    config = FIREBASE_CONFIG_FILE.read_text(encoding="utf-8")
    api_key = re.search(r'apiKey:\s*"([^"]+)"', config).group(1)
    project = re.search(r'projectId:\s*"([^"]+)"', config).group(1)
    base = f"https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/tickerRequests"

    requests, page_token = [], ""
    while True:
        payload = http.get_json(f"{base}?pageSize=300&key={api_key}" + (f"&pageToken={page_token}" if page_token else ""))
        for doc in payload.get("documents", []):
            ticker = doc["name"].rsplit("/", 1)[-1]
            requested_at = doc.get("fields", {}).get("requestedAt", {}).get("timestampValue", "")
            if ticker in directory:
                requests.append((requested_at, ticker))
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return [t for _, t in sorted(requests, reverse=True)]


SECTOR_FIELDS = ("price", "sma50", "sma200", "return1m", "return3m", "return6m", "return12m")


def build_sector_benchmarks(sector_etfs, providers):
    """{sector name: {"etf", price, SMAs, returns}} from sector ETF price history; a sector that fails is left out."""
    sectors = {}
    for sector, etf in sector_etfs.items():
        try:
            bars = providers.prices.price_history(etf)
        except FetchError as err:
            print(f"  sector {etf}: {err}")
            continue
        tech = technicals(bars)
        sectors[sector] = {"etf": etf, **{k: tech[k] for k in SECTOR_FIELDS}}
    print(f"Sector benchmarks: {len(sectors)}/{len(sector_etfs)}")
    return sectors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated tickers to build (for local testing; output still validated)")
    parser.add_argument("--skip-requests", action="store_true", help="don't read user-requested tickers from Firestore")
    args = parser.parse_args()

    universe = json.loads(UNIVERSE_FILE.read_text(encoding="utf-8"))
    core = universe["primary"] + universe["secondary"]
    directory = load_symbol_directory()
    http = HttpClient(min_interval_by_host={"data.sec.gov": 0.15, "www.sec.gov": 0.15, "cdn.cboe.com": 0.2})

    requested = []
    if not args.skip_requests and not args.only:
        try:
            requested = requested_tickers(http, directory)
        except (FetchError, AttributeError) as err:
            print(f"WARNING: could not read requested tickers from Firestore ({err}); building core universe only")

    tickers = args.only.upper().split(",") if args.only else list(dict.fromkeys(core + requested))[:MAX_TICKERS]
    unknown = [t for t in tickers if t not in directory]
    if unknown:
        sys.exit(f"Not in data/symbols.json: {', '.join(unknown)}")

    sec_user_agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if not sec_user_agent:
        print("WARNING: SEC_USER_AGENT not set; skipping SEC fundamentals")
    providers = Providers(
        prices=YahooChart(http),
        prices_fallback=NasdaqHistory(http),
        options=CboeOptions(http),
        filings=SecEdgar(http, sec_user_agent) if sec_user_agent else None,
        analyst=NasdaqAnalyst(http),
        news=YahooNews(http),
    )

    as_of = datetime.now(timezone.utc).date()
    print(f"Building {len(tickers)} tickers ({len(requested)} user-requested) as of {as_of}")

    def build(ticker):
        return ticker, *build_stock_record(ticker, directory[ticker], providers, as_of)

    stocks, failures = {}, {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for ticker, record, errors in pool.map(build, tickers):
            if record is None:
                failures[ticker] = errors
                print(f"  FAIL {ticker}: {'; '.join(errors)}")
                continue
            stocks[ticker] = record
            flags = failed_checks(record)
            notes = [f"{len(errors)} source error(s)"] if errors else []
            notes += [f"check {k}={v}%" for k, v in flags.items()]
            print(f"  ok   {ticker:6} ${record['price']:>9.2f}  {'; '.join(notes)}")
            for err in errors:
                print(f"         - {err}")

    sectors = {} if args.only else build_sector_benchmarks(universe.get("sectorEtfs", {}), providers)

    expected_core = [t for t in tickers if t in core]
    core_ok = [t for t in expected_core if t in stocks]
    missing_regime = [t for t in REGIME_TICKERS if t in expected_core and t not in stocks]
    if missing_regime or (expected_core and len(core_ok) / len(expected_core) < MIN_CORE_SUCCESS):
        sys.exit(f"Refusing to write {OUTPUT_FILE.name}: core {len(core_ok)}/{len(expected_core)} succeeded, missing regime tickers {missing_regime}")

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": universe,
        "requested": [t for t in requested if t in stocks],
        "sectors": sectors,
        "stocks": stocks,
        "failures": failures,
    }
    OUTPUT_FILE.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(stocks)} stocks to {OUTPUT_FILE} ({OUTPUT_FILE.stat().st_size // 1024} KB); {len(failures)} failed")


if __name__ == "__main__":
    main()
