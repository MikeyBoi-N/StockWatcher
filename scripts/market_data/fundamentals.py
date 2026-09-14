"""
Fundamental metrics from SEC EDGAR XBRL "company facts" (10-K/10-Q filers and 20-F/40-F foreign filers).

Trailing-twelve-month (TTM) values are summed from four fiscal quarters. 10-Q filings report cash-flow items
year-to-date, so single quarters are derived by differencing cumulative periods that share a start date.
When quarters are unavailable (e.g. annual-only 20-F filers) the latest fiscal year is used instead.
"""
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

PERIODIC_FORMS = ("10-K", "10-Q", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A", "40-F/A")
QUARTER_DAYS = range(80, 101)
ANNUAL_DAYS = range(350, 381)
PERIOD_ALIGNMENT_DAYS = 10
FOREIGN_FORMS = ("20-F", "40-F", "20-F/A", "40-F/A")
# Annual-only foreign filers can lag ~16 months; anything older than this is too stale to score.
MAX_PERIOD_AGE_DAYS = 500

DURATION_TAGS = {
    "revenue": {
        "us-gaap": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenuesNetOfInterestExpense",
                    "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
        "ifrs-full": ["Revenue"],
    },
    "operating_income": {"us-gaap": ["OperatingIncomeLoss"], "ifrs-full": ["ProfitLossFromOperatingActivities"]},
    "net_income": {
        "us-gaap": ["NetIncomeLoss", "ProfitLoss"],
        "ifrs-full": ["ProfitLossAttributableToOwnersOfParent", "ProfitLoss"],
    },
    "operating_cash_flow": {
        "us-gaap": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
        "ifrs-full": ["CashFlowsFromUsedInOperatingActivities"],
    },
    "capex": {
        "us-gaap": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
        "ifrs-full": ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
    },
    "depreciation": {
        "us-gaap": ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization",
                    "DepreciationAmortizationAndAccretionNet", "Depreciation"],
        "ifrs-full": ["DepreciationAndAmortisationExpense"],
    },
    "eps_diluted": {"us-gaap": ["EarningsPerShareDiluted"], "ifrs-full": ["DilutedEarningsLossPerShare"]},
}


@dataclass(frozen=True)
class Fact:
    start: date | None
    end: date
    val: float
    filed: str
    accn: str
    form: str


def _parse_entries(entries):
    """Keeps periodic-report facts, de-duplicated by period with the most recently filed value winning."""
    by_period = {}
    for e in entries:
        if e.get("form") not in PERIODIC_FORMS:
            continue
        fact = Fact(
            start=date.fromisoformat(e["start"]) if e.get("start") else None,
            end=date.fromisoformat(e["end"]),
            val=float(e["val"]),
            filed=e.get("filed", ""),
            accn=e.get("accn", ""),
            form=e["form"],
        )
        key = (fact.start, fact.end)
        if key not in by_period or fact.filed > by_period[key].filed:
            by_period[key] = fact
    return list(by_period.values())


def _pick_unit(units):
    """Prefer USD when it is as current as any other unit; otherwise the most current unit (e.g. TWD)."""
    latest = {unit: max(e["end"] for e in entries) for unit, entries in units.items() if entries}
    if not latest:
        return None
    newest = max(latest.values())
    usd = [u for u in latest if u.startswith("USD") and latest[u] == newest]
    return usd[0] if usd else max(latest, key=latest.get)


def concept_facts(companyfacts, concept):
    """Returns (unit, facts) for the candidate tag with the most recent data, so tag switches over time are handled."""
    facts = companyfacts.get("facts", {})
    best = None
    for taxonomy, tags in DURATION_TAGS[concept].items():
        for tag in tags:
            node = facts.get(taxonomy, {}).get(tag)
            if not node:
                continue
            unit = _pick_unit(node["units"])
            parsed = _parse_entries(node["units"].get(unit, [])) if unit else []
            parsed = [f for f in parsed if f.start]
            if not parsed:
                continue
            latest = max(f.end for f in parsed)
            if best is None or latest > best[0]:
                best = (latest, unit, parsed)
    return (best[1], best[2]) if best else (None, [])


def _days(fact):
    return (fact.end - fact.start).days


def quarterly_values(facts):
    """{quarter_end: value}. Discrete quarters win; the rest are derived from consecutive cumulative periods."""
    quarters = {f.end: f.val for f in facts if _days(f) in QUARTER_DAYS}
    by_start = defaultdict(list)
    for f in facts:
        if 80 <= _days(f) <= 380:
            by_start[f.start].append(f)
    for group in by_start.values():
        group.sort(key=lambda f: f.end)
        for prev, cur in zip(group, group[1:]):
            if (cur.end - prev.end).days in QUARTER_DAYS and cur.end not in quarters:
                quarters[cur.end] = cur.val - prev.val
    return quarters


def _quarter_ttm(quarters):
    ends = sorted(quarters)
    ttm = {}
    for i in range(3, len(ends)):
        window = ends[i - 3:i + 1]
        spaced = all((b - a).days in QUARTER_DAYS for a, b in zip(window, window[1:]))
        if spaced:
            ttm[ends[i]] = sum(quarters[e] for e in window)
    return ttm


def _near(series, end, days_back, tolerance=20):
    target = end - timedelta(days=days_back)
    candidates = [e for e in series if abs((e - target).days) <= tolerance]
    if not candidates:
        return None
    return series[min(candidates, key=lambda e: abs((e - target).days))]


def trailing_totals(facts):
    """(period_end, ttm_value, ttm_value_one_year_earlier) from quarters when possible, else fiscal years."""
    q_ttm = _quarter_ttm(quarterly_values(facts))
    annuals = {f.end: f.val for f in facts if _days(f) in ANNUAL_DAYS}
    latest_q = max(q_ttm) if q_ttm else None
    latest_a = max(annuals) if annuals else None

    if latest_q and (latest_a is None or latest_q >= latest_a):
        prior = _near(q_ttm, latest_q, 365)
        if prior is None:
            prior = _near(annuals, latest_q, 365)
        return latest_q, q_ttm[latest_q], prior
    if latest_a:
        return latest_a, annuals[latest_a], _near(annuals, latest_a, 365)
    return None, None, None


def latest_quarter_yoy(facts):
    """(quarter_end, latest_quarter_value, same_quarter_prior_year) for registrants without four quarters of history."""
    quarters = quarterly_values(facts)
    if not quarters:
        return None, None, None
    end = max(quarters)
    return end, quarters[end], _near(quarters, end, 365)


def _aligned_ttm(companyfacts, concept, period_end, basis="ttm"):
    """Current/prior pair for a concept on the same basis and period as revenue (stale tags are ignored)."""
    unit, facts = concept_facts(companyfacts, concept)
    if not facts:
        return unit, None, None
    end, ttm, prior = trailing_totals(facts) if basis == "ttm" else latest_quarter_yoy(facts)
    if end is None or abs((end - period_end).days) > PERIOD_ALIGNMENT_DAYS:
        return unit, None, None
    return unit, ttm, prior


def _latest_instant(companyfacts, tag, near_end=None):
    node = companyfacts.get("facts", {}).get("us-gaap", {}).get(tag)
    if not node or "USD" not in node["units"]:
        return None
    facts = [f for f in _parse_entries(node["units"]["USD"]) if f.start is None]
    if near_end:
        facts = [f for f in facts if abs((f.end - near_end).days) <= PERIOD_ALIGNMENT_DAYS]
    return max(facts, key=lambda f: f.end).val if facts else None


def _first_instant(companyfacts, tags, near_end):
    for tag in tags:
        value = _latest_instant(companyfacts, tag, near_end)
        if value is not None:
            return value
    return None


def balance_sheet(companyfacts, period_end):
    """Total debt and cash & short-term investments at the period end (US-GAAP filers only)."""
    long_term = _latest_instant(companyfacts, "LongTermDebt", period_end)
    if long_term is None:
        parts = [_latest_instant(companyfacts, t, period_end) for t in ("LongTermDebtNoncurrent", "LongTermDebtCurrent")]
        long_term = sum(p for p in parts if p is not None) if any(p is not None for p in parts) else None
    short_term = sum(v for v in (_latest_instant(companyfacts, t, period_end) for t in ("ShortTermBorrowings", "CommercialPaper")) if v)
    cash = _first_instant(companyfacts, ["CashAndCashEquivalentsAtCarryingValue",
                                          "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], period_end)
    investments = _first_instant(companyfacts, ["MarketableSecuritiesCurrent", "ShortTermInvestments",
                                                 "AvailableForSaleSecuritiesDebtSecuritiesCurrent"], period_end) or 0
    if long_term is None or cash is None:
        return None, None
    return long_term + short_term, cash + investments


def shares_outstanding(companyfacts):
    """Sum of all share classes from the cover page of the most recent filing."""
    node = companyfacts.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding")
    if not node or "shares" not in node["units"]:
        return None
    entries = node["units"]["shares"]
    latest_end = max(e["end"] for e in entries)
    latest = [e for e in entries if e["end"] == latest_end]
    newest_accn = max(latest, key=lambda e: e.get("filed", ""))["accn"]
    return sum(e["val"] for e in latest if e["accn"] == newest_accn)


def _ratio(numerator, denominator):
    if numerator is None or denominator is None or denominator <= 0:
        return None
    return numerator / denominator


def business_direction(revenue_growth, margin_change, earnings_growth):
    """
    +1/-1 votes: revenue growth (>5% / <0), operating margin change (>=+1pt / <=-1pt), earnings growth (>10% / <0).
    Total >= 2 is getting_stronger, <= -1 is getting_weaker, otherwise roughly_unchanged.
    """
    votes = 0
    if revenue_growth is not None:
        votes += 1 if revenue_growth > 0.05 else -1 if revenue_growth < 0 else 0
    if margin_change is not None:
        votes += 1 if margin_change >= 0.01 else -1 if margin_change <= -0.01 else 0
    if earnings_growth is not None:
        votes += 1 if earnings_growth > 0.10 else -1 if earnings_growth < 0 else 0
    if votes >= 2:
        return "getting_stronger"
    if votes <= -1:
        return "getting_weaker"
    return "roughly_unchanged"


def historical_average_pe(companyfacts, close_on_or_before, as_of, years=5):
    """Average P/E at each fiscal year end over the last `years` years (positive EPS years only; needs 3+)."""
    unit, facts = concept_facts(companyfacts, "eps_diluted")
    if not unit or not unit.startswith("USD"):
        return None
    cutoff = as_of - timedelta(days=365 * years + 30)
    pes = []
    for f in facts:
        if _days(f) in ANNUAL_DAYS and f.end >= cutoff and f.val > 0:
            price = close_on_or_before(f.end)
            if price:
                pes.append(price / f.val)
    return sum(pes) / len(pes) if len(pes) >= 3 else None


def compute_fundamentals(companyfacts, price, close_on_or_before, as_of):
    """
    companyfacts: SEC companyfacts JSON. close_on_or_before(date) -> float|None for historical P/E.
    Returns a dict of fundamentals (None when the filer has no usable revenue data).
    """
    revenue_unit, revenue_facts = concept_facts(companyfacts, "revenue")
    if not revenue_facts:
        return None
    basis = "ttm"
    period_end, revenue, revenue_prior = trailing_totals(revenue_facts)
    if revenue is None:
        # New registrants (spin-offs, IPOs, holding-company reorganizations) may lack four quarters of history;
        # compare the latest quarter with the same quarter a year earlier instead.
        basis = "latest_quarter_yoy"
        period_end, revenue, revenue_prior = latest_quarter_yoy(revenue_facts)
    if revenue is None or revenue <= 0 or (as_of - period_end).days > MAX_PERIOD_AGE_DAYS:
        return None
    # Foreign filers report per ordinary share, which rarely equals one US-listed ADR, so per-share
    # price ratios would be wrong; valuation multiples for them come from analyst data instead.
    foreign_filer = any(f.form in FOREIGN_FORMS for f in revenue_facts)

    _, operating_income, operating_income_prior = _aligned_ttm(companyfacts, "operating_income", period_end, basis)
    _, net_income, net_income_prior = _aligned_ttm(companyfacts, "net_income", period_end, basis)
    # Cash flow, leverage and per-share multiples need a full twelve months; a single quarter would mislead.
    full_year = basis == "ttm"
    _, ocf, ocf_prior = _aligned_ttm(companyfacts, "operating_cash_flow", period_end) if full_year else (None, None, None)
    _, capex, capex_prior = _aligned_ttm(companyfacts, "capex", period_end) if full_year else (None, None, None)
    _, depreciation, _ = _aligned_ttm(companyfacts, "depreciation", period_end) if full_year else (None, None, None)
    eps_unit, eps_ttm, _ = _aligned_ttm(companyfacts, "eps_diluted", period_end) if full_year else (None, None, None)

    revenue_growth = revenue / revenue_prior - 1 if revenue_prior and revenue_prior > 0 else None
    margin = _ratio(operating_income, revenue)
    margin_prior = _ratio(operating_income_prior, revenue_prior)
    margin_change = margin - margin_prior if margin is not None and margin_prior is not None else None
    earnings_growth = (net_income - net_income_prior) / net_income_prior if net_income is not None and net_income_prior and net_income_prior > 0 else None

    fcf = ocf - capex if ocf is not None and capex is not None else None
    fcf_prior = ocf_prior - capex_prior if ocf_prior is not None and capex_prior is not None else None
    fcf_trend = None
    if fcf is not None and fcf_prior is not None and fcf_prior != 0:
        change = (fcf - fcf_prior) / abs(fcf_prior)
        fcf_trend = "growing" if change > 0.05 else "shrinking" if change < -0.05 else "stable"

    net_debt_to_ebitda = None
    if revenue_unit == "USD":
        debt, cash = balance_sheet(companyfacts, period_end)
        ebitda = operating_income + depreciation if operating_income is not None and depreciation is not None else None
        if debt is not None and ebitda and ebitda > 0:
            net_debt_to_ebitda = (debt - cash) / ebitda

    usd_eps = not foreign_filer and eps_unit is not None and eps_unit.startswith("USD")
    trailing_pe = price / eps_ttm if usd_eps and eps_ttm and eps_ttm > 0 else None

    return {
        "source": "SEC EDGAR XBRL",
        "periodEnd": period_end.isoformat(),
        "basis": basis,
        "reportingCurrency": revenue_unit,
        "foreignFiler": foreign_filer,
        "revenue": round(revenue),
        "revenueGrowthYoY": _round(revenue_growth, 4),
        "earningsGrowthYoY": _round(earnings_growth, 4),
        "operatingMargin": _round(margin, 4),
        "operatingMarginChange": _round(margin_change, 4),
        "freeCashFlow": round(fcf) if fcf is not None else None,
        "fcfTrend": fcf_trend,
        "netDebtToEbitda": _round(net_debt_to_ebitda, 2),
        "epsTTM": _round(eps_ttm, 2) if usd_eps else None,
        "trailingPe": _round(trailing_pe, 1),
        "historical5yPe": None if foreign_filer else _round(historical_average_pe(companyfacts, close_on_or_before, as_of), 1),
        "sharesOutstanding": shares_outstanding(companyfacts),
        "direction": business_direction(revenue_growth, margin_change, earnings_growth),
    }


def _round(value, digits):
    return None if value is None else round(value, digits)
