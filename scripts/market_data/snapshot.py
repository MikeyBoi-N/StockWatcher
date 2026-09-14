"""Assembles one stock's record from all providers, isolating failures per source."""
from bisect import bisect_right
from datetime import date

from . import analyst
from .fundamentals import compute_fundamentals
from .http_client import FetchError
from .indicators import technicals
from .options import summarize_chain

# Cross-source deviations above this are reported so bad data is caught instead of silently scored.
CHECK_TOLERANCE_PCT = 2.0


def _pct_diff(a, b):
    if a is None or b is None or b == 0:
        return None
    return round((a - b) / b * 100, 2)


def _attempt(errors, label, fn):
    try:
        return fn()
    except FetchError as err:
        errors.append(f"{label}: {err}")
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as err:
        errors.append(f"{label}: unexpected response ({type(err).__name__}: {err})")
    return None


def build_stock_record(symbol, meta, providers, as_of):
    """
    meta: {"name", "exchange", "etf"} from the symbol directory. providers: sources.Providers.
    Returns (record | None, errors). A record requires price history; every other source is optional.
    """
    errors = []
    is_etf = bool(meta.get("etf"))

    bars = _attempt(errors, "prices (Yahoo)", lambda: providers.prices.price_history(symbol))
    if bars is None:
        bars = _attempt(errors, "prices (Nasdaq fallback)", lambda: providers.prices_fallback.price_history(symbol, is_etf, as_of))
    if bars is None:
        return None, errors

    tech = technicals(bars)
    price = tech["price"]

    def close_on_or_before(day):
        index = bisect_right(bars.dates, day) - 1
        return bars.close[index] if index >= 0 else None

    summary_payload = _attempt(errors, "quote summary", lambda: providers.analyst.summary(symbol, is_etf))
    summary = analyst.parse_summary(summary_payload)

    fundamentals, forecast, peg, earnings = None, None, None, (None, None)
    if not is_etf:
        if providers.filings:
            facts = _attempt(errors, "SEC filings", lambda: providers.filings.company_facts(symbol))
            if facts:
                fundamentals = _attempt(errors, "fundamentals", lambda: compute_fundamentals(facts, price, close_on_or_before, as_of))
        forecast = analyst.parse_forecast(_attempt(errors, "EPS forecast", lambda: providers.analyst.forecast(symbol)))
        peg = analyst.parse_peg(_attempt(errors, "PEG ratio", lambda: providers.analyst.peg(symbol)))
        earnings = analyst.parse_earnings_date(_attempt(errors, "earnings date", lambda: providers.analyst.earnings_date(symbol)))

    chain = _attempt(errors, "options chain", lambda: providers.options.chain(symbol))
    options = summarize_chain(chain, price, as_of, tech["hv30"]) if chain else None

    market_cap = summary["marketCap"]
    if not market_cap and fundamentals and not fundamentals["foreignFiler"] and fundamentals["sharesOutstanding"]:
        market_cap = fundamentals["sharesOutstanding"] * price

    fcf_yield = None
    if fundamentals and fundamentals["freeCashFlow"] is not None and fundamentals["reportingCurrency"] == "USD" and market_cap:
        fcf_yield = round(fundamentals["freeCashFlow"] / market_cap, 4)

    ntm_eps = forecast["ntmEps"] if forecast else None
    earnings_date, earnings_estimated = earnings
    days_to_earnings = (date.fromisoformat(earnings_date) - as_of).days if earnings_date else None

    record = {
        "ticker": symbol,
        "name": meta.get("name", symbol),
        "exchange": meta.get("exchange"),
        "etf": is_etf,
        "sector": summary["sector"],
        "industry": summary["industry"],
        "asOf": bars.last_time,
        **tech,
        "marketCap": round(market_cap) if market_cap else None,
        "fundamentals": fundamentals,
        "valuation": {
            "forwardPe": round(price / ntm_eps, 1) if ntm_eps and ntm_eps > 0 else None,
            "trailingPe": fundamentals["trailingPe"] if fundamentals else None,
            "historical5yPe": fundamentals["historical5yPe"] if fundamentals else None,
            "pegRatio": peg,
            "fcfYield": fcf_yield,
        },
        "catalysts": {
            "nextEarningsDate": earnings_date,
            "earningsDateEstimated": earnings_estimated,
            "daysToEarnings": days_to_earnings if days_to_earnings is not None and days_to_earnings >= 0 else None,
            "ntmEps": ntm_eps,
            "analystCount": forecast["analystCount"] if forecast else None,
            "revisionsUp": forecast["revisionsUp"] if forecast else None,
            "revisionsDown": forecast["revisionsDown"] if forecast else None,
            "oneYearTarget": summary["oneYearTarget"],
        },
        "options": options,
        "sources": {
            "prices": bars.source,
            "fundamentals": fundamentals["source"] if fundamentals else None,
            "analyst": providers.analyst.name if (forecast or peg or earnings_date or summary_payload) else None,
            "options": options["source"] if options else None,
        },
        "checks": {
            "priceVsCboePct": _pct_diff(price, ((chain or {}).get("data") or {}).get("current_price")),
            "high52VsNasdaqPct": _pct_diff(tech["high52"], summary["high52"]),
            "low52VsNasdaqPct": _pct_diff(tech["low52"], summary["low52"]),
        },
        "errors": errors,
    }
    return record, errors


def failed_checks(record):
    return {k: v for k, v in record["checks"].items() if v is not None and abs(v) > CHECK_TOLERANCE_PCT}
