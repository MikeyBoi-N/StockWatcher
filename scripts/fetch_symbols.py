"""Build data/symbols.json from Nasdaq Trader's public symbol directories.

Covers every US-listed common stock and ETF (NASDAQ, NYSE, NYSE American, NYSE Arca,
Cboe BZX, IEX). Test issues, warrants, rights, units and preferred series are dropped.

Output shape: {"generated": ISO timestamp, "fields": [...], "symbols": [[symbol, name, exchange, isEtf], ...]}
"""
import csv
import io
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

NASDAQ_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
OTHER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "symbols.json"

OTHER_EXCHANGES = {"A": "NYSE American", "N": "NYSE", "P": "NYSE Arca", "Z": "Cboe BZX", "V": "IEX"}
DERIVATIVE_NAME = re.compile(r"\b(warrants?|rights?)\b|- units?$|\bunits?,? each consisting|preferred|depositary shares? each representing", re.I)
NAME_SUFFIX = re.compile(r"\s*-?\s*(common stock|ordinary shares?|common shares?|common units( representing .*)?)\s*$", re.I)


def fetch_rows(url):
    """Download a pipe-delimited directory file and yield its data rows (footer line excluded)."""
    request = urllib.request.Request(url, headers={"User-Agent": "StockWatcher symbol builder"})
    with urllib.request.urlopen(request, timeout=60) as response:
        text = response.read().decode("utf-8", errors="replace")
    for row in csv.DictReader(io.StringIO(text), delimiter="|"):
        if next(iter(row.values()), "").startswith("File Creation Time"):
            continue
        yield row


def clean_name(name):
    return NAME_SUFFIX.sub("", " ".join(name.split()))


def keep(symbol, name, is_etf, test_issue):
    if not symbol or test_issue == "Y" or "$" in symbol:
        return False
    return is_etf or not DERIVATIVE_NAME.search(name)


def build():
    symbols = {}
    for row in fetch_rows(NASDAQ_URL):
        symbol, name, is_etf = row["Symbol"].strip(), row["Security Name"], row["ETF"] == "Y"
        if keep(symbol, name, is_etf, row["Test Issue"]):
            symbols[symbol] = [symbol, clean_name(name), "NASDAQ", int(is_etf)]
    for row in fetch_rows(OTHER_URL):
        symbol, name, is_etf = row["ACT Symbol"].strip(), row["Security Name"], row["ETF"] == "Y"
        if keep(symbol, name, is_etf, row["Test Issue"]):
            symbols[symbol] = [symbol, clean_name(name), OTHER_EXCHANGES.get(row["Exchange"], row["Exchange"]), int(is_etf)]

    if len(symbols) < 5000:
        raise RuntimeError(f"Only {len(symbols)} symbols parsed; source format may have changed.")

    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fields": ["symbol", "name", "exchange", "etf"],
        "symbols": [symbols[key] for key in sorted(symbols)],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(symbols)} symbols to {OUTPUT}")


if __name__ == "__main__":
    build()
