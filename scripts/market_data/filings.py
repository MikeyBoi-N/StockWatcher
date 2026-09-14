"""
Material events from recent SEC Form 8-K filings, labeled from the item numbers the company itself selects.

No filing text is interpreted: an 8-K with item 2.05 is, by definition, a restructuring (exit or disposal costs).
"""
from datetime import date, timedelta

# Form 8-K item numbers -> (plain-language label, short label for table rows, tone). Routine items are left out as noise:
# 5.07 shareholder vote results, 7.01 Regulation FD, 8.01 other events, 9.01 exhibits.
ITEMS = {
    "1.01": ("Entered a material agreement", "New agreement", "neutral"),
    "1.02": ("Ended a material agreement", "Agreement ended", "neutral"),
    "1.03": ("Bankruptcy or receivership", "Bankruptcy", "negative"),
    "1.05": ("Material cybersecurity incident", "Cyber incident", "negative"),
    "2.01": ("Completed an acquisition or sale of assets", "Deal closed", "neutral"),
    "2.02": ("Released results or a financial update", "Results", "neutral"),
    "2.03": ("Took on significant new debt", "New debt", "neutral"),
    "2.04": ("Debt repayment accelerated", "Debt accelerated", "negative"),
    "2.05": ("Restructuring (layoffs, closures or exit costs)", "Restructuring", "negative"),
    "2.06": ("Impairment (asset write-down)", "Impairment", "negative"),
    "3.01": ("Delisting notice or listing transfer", "Delisting notice", "negative"),
    "3.02": ("Sold unregistered shares", "Share sale", "neutral"),
    "3.03": ("Changed shareholder rights", "Shareholder rights change", "neutral"),
    "4.01": ("Changed auditor", "Auditor change", "neutral"),
    "4.02": ("Past financial statements no longer reliable", "Restatement", "negative"),
    "5.01": ("Change in control", "Change in control", "neutral"),
    "5.02": ("Executive or director change", "Leadership change", "neutral"),
    "5.03": ("Amended bylaws or fiscal year", "Bylaws change", "neutral"),
}
EIGHT_K_FORMS = ("8-K", "8-K/A")
LOOKBACK_DAYS = 120
MAX_EVENTS = 8


def recent_events(submissions, as_of, lookback_days=LOOKBACK_DAYS, limit=MAX_EVENTS):
    """
    submissions: SEC submissions JSON (data.sec.gov/submissions/CIK##########.json).
    Returns [{"date", "form", "items": [{"code", "label", "short", "tone"}], "url"}], newest first.
    """
    recent = submissions["filings"]["recent"]
    cik = int(submissions["cik"])
    cutoff = as_of - timedelta(days=lookback_days)
    events = []
    rows = zip(recent["form"], recent["filingDate"], recent["items"], recent["accessionNumber"], recent["primaryDocument"])
    for form, filed, items, accession, document in rows:
        if form not in EIGHT_K_FORMS or date.fromisoformat(filed) < cutoff:
            continue
        codes = [code.strip() for code in items.split(",")]
        labeled = [{"code": code, "label": ITEMS[code][0], "short": ITEMS[code][1], "tone": ITEMS[code][2]} for code in codes if code in ITEMS]
        if not labeled:
            continue
        events.append({
            "date": filed,
            "form": form,
            "items": labeled,
            "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{document}",
        })
    events.sort(key=lambda e: e["date"], reverse=True)
    return events[:limit]
