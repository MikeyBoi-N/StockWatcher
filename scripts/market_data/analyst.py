"""Parsers for Nasdaq.com quote and analyst (Zacks consensus) JSON responses."""
import re
from datetime import datetime

DATE_IN_TEXT = re.compile(r"(\d{1,2}/\d{1,2}/\d{4})")


def _number(text):
    """'$1,234.50' -> 1234.5; 'N/A' or missing -> None."""
    if text is None:
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", str(text))
    try:
        return float(cleaned) if cleaned not in ("", "-", ".") else None
    except ValueError:
        return None


def parse_earnings_date(payload):
    """Returns (iso_date, is_estimated) or (None, None) when Zacks has no upcoming date."""
    text = ((payload or {}).get("data") or {}).get("reportText") or ""
    match = DATE_IN_TEXT.search(text)
    if not match:
        return None, None
    parsed = datetime.strptime(match.group(1), "%m/%d/%Y").date()
    return parsed.isoformat(), "estimated" in text.lower()


def parse_forecast(payload):
    """
    Next-twelve-month consensus EPS (sum of the next four fiscal quarters) and 4-week revision counts.
    Returns None when fewer than four quarterly estimates are available.
    """
    rows = (((payload or {}).get("data") or {}).get("quarterlyForecast") or {}).get("rows") or []
    estimates = [_number(r.get("consensusEPSForecast")) for r in rows[:4]]
    if len(estimates) < 4 or any(e is None for e in estimates):
        return None
    return {
        "ntmEps": round(sum(estimates), 2),
        "analystCount": max(int(_number(r.get("noOfEstimates")) or 0) for r in rows[:4]),
        "revisionsUp": sum(int(_number(r.get("up")) or 0) for r in rows[:4]),
        "revisionsDown": sum(int(_number(r.get("down")) or 0) for r in rows[:4]),
    }


def parse_peg(payload):
    peg = (((payload or {}).get("data") or {}).get("pegr") or {}).get("pegValue")
    value = _number(peg)
    return value if value and value > 0 else None


def parse_summary(payload):
    summary = ((payload or {}).get("data") or {}).get("summaryData") or {}

    def field(key):
        return (summary.get(key) or {}).get("value")

    high_low = str(field("FiftTwoWeekHighLow") or "").split("/")
    return {
        "high52": _number(high_low[0]) if len(high_low) == 2 else None,
        "low52": _number(high_low[1]) if len(high_low) == 2 else None,
        "sector": field("Sector"),
        "industry": field("Industry"),
        "marketCap": _number(field("MarketCap")),
        "oneYearTarget": _number(field("OneYrTarget")),
    }
