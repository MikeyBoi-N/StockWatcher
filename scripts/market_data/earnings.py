"""
Past earnings releases from SEC EDGAR, for the simulator's earnings-aware model and for later model training.

An earnings release is an 8-K carrying Item 2.02 (Results of Operations and Financial Condition). Its acceptance time
says which session first traded on the news: filed by the 4pm Eastern close, the release came before the open or
during that session (companies file the 8-K at or after the press release), so that session reacts; filed after the
close, the next one does. Item 2.02 also covers the odd unscheduled pre-announcement, which is kept: it is a real
information event, though not one anyone could have dated in advance.

EDGAR's submissions file lists at least the most recent year of filings; older ones sit in extra pages. Heavy filers
(banks issue thousands of notes a year) need dozens of pages for five years, so each build starts from the previous
build's list and only pages back for tickers it doesn't already cover.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
CLOSE_HOUR = 16
EARNINGS_ITEM = "2.02"


def reaction_session(accepted):
    """
    EDGAR acceptance time (ISO, UTC, e.g. '2026-07-31T00:30:28.000Z') -> ISO date of the first session that could
    trade on it. A weekend rolls to Monday; a holiday is left to the caller, which maps the date onto the next candle.
    """
    eastern = datetime.fromisoformat(accepted.replace("Z", "+00:00")).astimezone(EASTERN)
    day = eastern.date() + timedelta(days=1 if eastern.hour >= CLOSE_HOUR else 0)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day.isoformat()


def release_sessions(block):
    """Reaction sessions of the Item 2.02 8-Ks in one EDGAR filings block (columnar, like `filings.recent`)."""
    rows = zip(block["form"], block["items"], block["acceptanceDateTime"])
    return {reaction_session(accepted) for form, items, accepted in rows
            if form == "8-K" and EARNINGS_ITEM in [code.strip() for code in (items or "").split(",")]}


def earnings_history(edgar, symbol, since, previous=None):
    """
    Earnings reaction sessions from `since` (date) on, as {"from": ISO date, "dates": [ISO dates, ascending]}: the list
    is complete from `from`, so a date missing after it means no release, not a gap in the data.
    previous: this ticker's entry from the last build. When it already reaches back to `since`, only the latest
    filings are fetched and merged in. None for a symbol with no SEC registrant.
    """
    payload = edgar.submissions(symbol)
    if payload is None:
        return None
    recent = payload["filings"]["recent"]
    dates = release_sessions(recent)
    start = since.isoformat()

    if previous and previous["from"] <= start:
        dates |= set(previous["dates"])
    elif min(recent["filingDate"], default=start) > start:
        # Older pages, newest first, until one ends before `since`; running out of pages means there were no more filings.
        for page in sorted(payload["filings"].get("files", []), key=lambda p: p["filingTo"], reverse=True):
            if page["filingTo"] < start:
                break
            dates |= release_sessions(edgar.submissions_page(page["name"]))
    return {"from": start, "dates": sorted(d for d in dates if d >= start)}
