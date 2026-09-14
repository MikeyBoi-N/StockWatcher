from datetime import date

from market_data.filings import recent_events
from market_data.fundamentals import compute_fundamentals
from market_data.news import company_patterns, headline_tone, recent_headlines

from conftest import FIXTURES

AS_OF = date(2026, 9, 14)


def rss(*items):
    body = "".join(f"<item><title>{t}</title><link>{link}</link><pubDate>{when}</pubDate></item>" for t, link, when in items)
    return f"<rss><channel>{body}</channel></rss>".encode()


def test_8k_events_are_labeled_from_item_numbers(fixture):
    events = recent_events(fixture("sec_aapl_submissions.json"), AS_OF)
    assert [e["date"] for e in events] == ["2026-09-01", "2026-07-30"]   # older filings are outside 120 days
    assert events[0]["form"] == "8-K/A"
    assert [i["code"] for i in events[1]["items"]] == ["2.02"]           # 9.01 exhibits dropped as routine
    assert events[1]["url"] == "https://www.sec.gov/Archives/edgar/data/320193/000032019326000018/aapl-20260730.htm"


def test_routine_only_8ks_are_skipped():
    submissions = {"cik": "1", "filings": {"recent": {
        "form": ["8-K", "8-K", "10-Q"], "filingDate": ["2026-09-10", "2026-09-09", "2026-09-08"],
        "items": ["7.01,9.01", "2.05", ""], "accessionNumber": ["a-1", "b-2", "c-3"], "primaryDocument": ["a.htm", "b.htm", "c.htm"]
    }}}
    events = recent_events(submissions, AS_OF)
    assert len(events) == 1 and events[0]["items"][0]["tone"] == "negative"


def test_real_feed_keeps_only_headlines_naming_the_company():
    headlines = recent_headlines((FIXTURES / "yahoo_aapl_rss.xml").read_bytes(), "AAPL", "Apple Inc.", AS_OF)
    assert len(headlines) == 6
    assert all("Apple" in h["title"] or "AAPL" in h["title"] for h in headlines)
    assert [h["published"] for h in headlines] == sorted((h["published"] for h in headlines), reverse=True)
    assert not any("Dell" in h["title"] or "Corning" in h["title"] for h in headlines)


def test_headline_filter_rejects_stale_duplicate_and_non_http_items():
    feed = rss(
        ("Apple raises dividend", "https://example.com/a", "Mon, 14 Sep 2026 10:00:00 +0000"),
        ("Apple raises dividend", "https://example.com/b", "Mon, 14 Sep 2026 09:00:00 +0000"),
        ("Apple sued over App Store", "javascript:alert(1)", "Mon, 14 Sep 2026 09:00:00 +0000"),
        ("Apple cuts guidance", "https://example.com/c", "Mon, 31 Aug 2026 09:00:00 +0000"),
        ("Apple wins contract", "https://example.com/d", "not a date"),
    )
    headlines = recent_headlines(feed, "AAPL", "Apple Inc.", AS_OF)
    assert [(h["title"], h["publisher"], h["tone"]) for h in headlines] == [("Apple raises dividend", "example.com", "positive")]


def test_company_patterns_avoid_generic_words_and_short_tickers():
    amd = company_patterns("AMD", "Advanced Micro Devices, Inc.")
    assert any(p.search("Advanced Micro Devices unveils chip") for p in amd)
    assert any(p.search("Why $AMD fell today") for p in amd)
    assert not any(p.search("Advanced packaging demand grows") for p in amd)
    jpm = company_patterns("JPM", "JP Morgan Chase & Co.")
    assert any(p.search("JPMorgan raises outlook") for p in jpm)
    assert not any(p.search("A win for investors") for p in company_patterns("A", "Agilent Technologies, Inc."))


def test_headline_tone_uses_event_phrases_not_opinions():
    assert headline_tone("Morgan Stanley upgrades Nvidia") == "positive"
    assert headline_tone("Intel cuts full-year guidance, announces layoffs") == "negative"
    assert headline_tone("History suggests you'll regret not buying this stock") == "neutral"
    assert headline_tone("Don't miss this AI stock") == "neutral"
    assert headline_tone("AMD Shares Fall 5.6% as AI Debate Weighs on Chips") == "negative"
    assert headline_tone("Prediction: This Memory Stock Could Surge 233%") == "neutral"


def test_latest_quarter_and_capital_returns(fixture):
    result = compute_fundamentals(fixture("sec_aapl.json"), 332.27, lambda d: 200.0, AS_OF)
    q = result["latestQuarter"]
    assert q["periodEnd"] == result["periodEnd"] and q["currency"] == "USD"
    assert q["revenuePriorYear"] == 94_036_000_000    # Apple fiscal Q3 2025 net sales, as reported
    assert q["netIncome"] > 0 and q["operatingIncome"] > 0
    assert result["buybacksTTM"] > 0 and result["dividendsTTM"] > 0
