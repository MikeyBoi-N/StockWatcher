from datetime import date

from market_data.http_client import FetchError
from market_data.snapshot import build_stock_record, failed_checks
from market_data.sources import Providers, YahooChart

AS_OF = date(2026, 9, 14)


class FakeHttp:
    def __init__(self, payload):
        self.payload = payload

    def get_json(self, url, headers=None):
        return self.payload


class Failing:
    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise FetchError(f"{name} unavailable")
        return fail


class StubAnalyst:
    name = "stub analyst"

    def __init__(self, fixture):
        self.fixture = fixture

    def summary(self, symbol, is_etf):
        return self.fixture("nasdaq_aapl_summary.json")

    def earnings_date(self, symbol):
        return self.fixture("nasdaq_aapl_earnings_date.json")

    def forecast(self, symbol):
        return self.fixture("nasdaq_aapl_forecast.json")

    def peg(self, symbol):
        return self.fixture("nasdaq_aapl_peg.json")


class StubFilings:
    def __init__(self, fixture):
        self.fixture = fixture

    def company_facts(self, symbol):
        return self.fixture("sec_aapl.json")


class StubOptions:
    def __init__(self, fixture):
        self.fixture = fixture

    def chain(self, symbol):
        return self.fixture("cboe_aapl.json")


def yahoo(fixture):
    return YahooChart(FakeHttp(fixture("yahoo_aapl_3mo.json")))


def test_yahoo_adapter_parses_real_chart(fixture):
    bars = yahoo(fixture).price_history("AAPL")
    assert bars.last_price == 332.27
    assert bars.dates == sorted(bars.dates) and len(bars.dates) == len(set(bars.dates))
    assert bars.dates[-1] == date(2026, 9, 11)   # exchange-local date, not UTC


def test_full_record_from_all_sources(fixture):
    providers = Providers(yahoo(fixture), Failing(), StubOptions(fixture), StubFilings(fixture), StubAnalyst(fixture))
    record, errors = build_stock_record("AAPL", {"name": "Apple Inc.", "exchange": "NASDAQ", "etf": False}, providers, AS_OF)
    assert errors == []
    assert record["price"] == 332.27
    assert record["fundamentals"]["source"] == "SEC EDGAR XBRL"
    assert record["valuation"]["forwardPe"] == round(332.27 / record["catalysts"]["ntmEps"], 1)
    assert 0 < record["valuation"]["fcfYield"] < 0.2
    assert record["catalysts"]["daysToEarnings"] == 45
    assert record["options"]["atmCallStrike"] > 0
    assert record["sma200"] is None        # only 3 months of fixture history
    # The 3-month fixture can't contain the true 52-week low, and the cross-source check must catch that.
    assert set(failed_checks(record)) == {"low52VsNasdaqPct"}


def test_price_fallback_is_used_when_primary_fails(fixture):
    class NasdaqStub:
        def price_history(self, symbol, is_etf, today):
            return yahoo(fixture).price_history(symbol)

    providers = Providers(Failing(), NasdaqStub(), Failing(), None, Failing())
    record, errors = build_stock_record("AAPL", {"etf": False}, providers, AS_OF)
    assert record is not None and record["price"] == 332.27
    assert any("prices (Yahoo)" in e for e in errors)
    assert record["fundamentals"] is None and record["options"] is None


def test_etf_skips_company_sources(fixture):
    class ExplodingFilings:
        def company_facts(self, symbol):
            raise AssertionError("ETFs must not query SEC")

    providers = Providers(yahoo(fixture), Failing(), Failing(), ExplodingFilings(), StubAnalyst(fixture))
    record, _ = build_stock_record("SPY", {"etf": True}, providers, AS_OF)
    assert record["etf"] is True and record["fundamentals"] is None
    assert record["catalysts"]["nextEarningsDate"] is None


def test_no_record_when_all_price_sources_fail():
    providers = Providers(Failing(), Failing(), Failing(), None, Failing())
    record, errors = build_stock_record("AAPL", {"etf": False}, providers, AS_OF)
    assert record is None and len(errors) == 2
