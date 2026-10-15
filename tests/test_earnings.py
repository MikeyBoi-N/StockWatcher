from datetime import date

from market_data.earnings import earnings_history, reaction_session, release_sessions


def test_release_after_the_close_moves_the_next_session():
    assert reaction_session("2026-07-31T00:30:28.000Z") == "2026-07-31"   # 8:30pm EDT Thursday -> Friday
    assert reaction_session("2026-01-30T02:30:33.000Z") == "2026-01-30"   # 9:30pm EST Thursday -> Friday
    assert reaction_session("2026-07-14T14:30:38.000Z") == "2026-07-14"   # mid-morning filing after a pre-market release
    assert reaction_session("2026-07-14T19:59:00.000Z") == "2026-07-14"   # 3:59pm EDT, still that session
    assert reaction_session("2026-07-14T20:01:00.000Z") == "2026-07-15"   # 4:01pm EDT
    assert reaction_session("2026-10-16T21:05:00.000Z") == "2026-10-19"   # Friday after the close -> Monday


def block(*rows):
    """A columnar EDGAR filings block from (form, items, filingDate, acceptanceDateTime) rows."""
    return {key: [r[i] for r in rows] for i, key in enumerate(["form", "items", "filingDate", "acceptanceDateTime"])}


def test_only_original_8ks_with_item_2_02_count():
    sessions = release_sessions(block(
        ("8-K", "2.02,9.01", "2026-07-30", "2026-07-31T00:30:28.000Z"),
        ("8-K/A", "2.02", "2026-08-02", "2026-08-02T14:00:00.000Z"),
        ("8-K", "5.02", "2026-06-01", "2026-06-01T14:00:00.000Z"),
        ("10-Q", "", "2026-08-01", "2026-08-01T14:00:00.000Z"),
        ("8-K", "12.02", "2026-05-01", "2026-05-01T14:00:00.000Z"),
    ))
    assert sessions == {"2026-07-31"}


class FakeEdgar:
    def __init__(self, recent, pages):
        self.recent, self.pages, self.fetched = recent, pages, []

    def submissions(self, symbol):
        files = [{"name": n, "filingFrom": min(p["filingDate"]), "filingTo": max(p["filingDate"])} for n, p in self.pages.items()]
        return {"filings": {"recent": self.recent, "files": files}}

    def submissions_page(self, name):
        self.fetched.append(name)
        return self.pages[name]


def heavy_filer():
    recent = block(("8-K", "2.02", "2026-07-14", "2026-07-14T14:30:00.000Z"), ("424B2", "", "2025-10-01", "2025-10-01T14:00:00.000Z"))
    pages = {
        "p1": block(("8-K", "2.02", "2025-07-15", "2025-07-15T14:30:00.000Z"), ("424B2", "", "2025-01-02", "2025-01-02T14:00:00.000Z")),
        "p2": block(("8-K", "2.02", "2024-07-12", "2024-07-12T14:30:00.000Z"), ("424B2", "", "2024-01-02", "2024-01-02T14:00:00.000Z")),
        "p3": block(("8-K", "2.02", "2023-07-14", "2023-07-14T14:30:00.000Z"), ("424B2", "", "2023-01-02", "2023-01-02T14:00:00.000Z")),
    }
    return FakeEdgar(recent, pages)


def test_pages_back_only_as_far_as_needed():
    edgar = heavy_filer()
    history = earnings_history(edgar, "JPM", date(2024, 6, 1))
    assert history == {"from": "2024-06-01", "dates": ["2024-07-12", "2025-07-15", "2026-07-14"]}
    assert edgar.fetched == ["p1", "p2"], "p3 ends before the window"


def test_a_previous_list_that_covers_the_window_skips_the_old_pages():
    edgar = heavy_filer()
    previous = {"from": "2024-01-01", "dates": ["2024-07-12", "2025-07-15"]}
    history = earnings_history(edgar, "JPM", date(2024, 6, 1), previous)
    assert history == {"from": "2024-06-01", "dates": ["2024-07-12", "2025-07-15", "2026-07-14"]}
    assert edgar.fetched == []
    # A previous list that starts too late doesn't count as coverage.
    assert earnings_history(heavy_filer(), "JPM", date(2023, 6, 1), previous)["dates"][0] == "2023-07-14"
