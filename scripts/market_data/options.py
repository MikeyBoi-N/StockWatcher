"""Summarizes a Cboe delayed options chain into the at-the-money contract metrics the engine uses."""
import math
import re
from datetime import date

OCC_SYMBOL = re.compile(r"^(?P<root>.+?)(?P<expiry>\d{6})(?P<kind>[CP])(?P<strike>\d{8})$")
TARGET_DTE = 52          # middle of the preferred 45-60 DTE window
PREFERRED_DTE = range(40, 71)
FALLBACK_DTE = range(21, 121)


def parse_occ(symbol):
    """'AAPL261218P00260000' -> (date(2026, 12, 18), 'P', 260.0), or None if malformed."""
    match = OCC_SYMBOL.match(symbol)
    if not match:
        return None
    expiry = date(2000 + int(match["expiry"][:2]), int(match["expiry"][2:4]), int(match["expiry"][4:]))
    return expiry, match["kind"], int(match["strike"]) / 1000


def is_monthly(expiry):
    """Standard monthly expiration: third Friday, or the Thursday before when that Friday is a holiday."""
    return (expiry.weekday() == 4 and 15 <= expiry.day <= 21) or (expiry.weekday() == 3 and 14 <= expiry.day <= 20)


def choose_expiration(expirations, as_of):
    """
    Expiration closest to TARGET_DTE inside the 40-70 DTE window, else inside 21-120 DTE. Monthly expirations
    are preferred within each window because they carry most of the open interest (tighter, more reliable quotes).
    """
    for window in (PREFERRED_DTE, FALLBACK_DTE):
        candidates = [e for e in expirations if (e - as_of).days in window]
        monthly = [e for e in candidates if is_monthly(e)]
        pool = monthly or candidates
        if pool:
            return min(pool, key=lambda e: abs((e - as_of).days - TARGET_DTE))
    return None


def _atm_iv(at_expiry, price):
    """Mean call/put IV at the strike nearest the price, or None. at_expiry: [(expiry, kind, strike, quote)]."""
    quoted = [c for c in at_expiry if c[3].get("iv", 0) > 0]
    if not quoted:
        return None
    strike = min(quoted, key=lambda c: abs(c[2] - price))[2]
    ivs = [c[3]["iv"] for c in quoted if c[2] == strike]
    return sum(ivs) / len(ivs)


def _term_iv(points, dte):
    """
    Constant-maturity IV at `dte` days from [(dte, iv)], interpolating total variance (iv² · t) between the expirations
    on either side. None when `dte` is outside the quoted range: no extrapolation.
    """
    below = [p for p in points if p[0] <= dte]
    above = [p for p in points if p[0] >= dte]
    if not below or not above:
        return None
    (t1, v1), (t2, v2) = max(below), min(above)
    if t1 == t2:
        return v1
    variance = v1 ** 2 * t1 + (v2 ** 2 * t2 - v1 ** 2 * t1) * (dte - t1) / (t2 - t1)
    return math.sqrt(variance / dte) if variance > 0 else None


def _iv_at_delta(at_expiry, kind, target):
    """
    IV at an out-of-the-money delta (e.g. P at -0.25), linear in delta between the two bid contracts around it.
    None when the quoted deltas don't reach the target on both sides.
    """
    otm = sorted((c[3]["delta"], c[3]["iv"]) for c in at_expiry
                 if c[1] == kind and c[3].get("bid", 0) > 0 and c[3].get("iv", 0) > 0
                 and isinstance(c[3].get("delta"), (int, float)) and 0 < abs(c[3]["delta"]) < 0.5)
    for (d1, v1), (d2, v2) in zip(otm, otm[1:]):
        if d1 <= target <= d2:
            return v1 if d1 == d2 else v1 + (v2 - v1) * (target - d1) / (d2 - d1)
    return None


def _earnings_move(by_expiry, price, as_of, earnings_date):
    """
    The one-day move the options market prices for earnings, from the term structure: total variance of the first
    expiration after the date, minus what the last expiration before it implies for the same span without the event
    (Dubinsky & Johannes). Expirations on the date itself are skipped, since the release can fall either side of the
    close. Also the raw at-the-money straddle of that first expiration, as a fraction of the price. (None, None) without
    an earnings date or a usable expiration after it.
    """
    if not earnings_date:
        return None, None
    event = date.fromisoformat(earnings_date)
    after = min((e for e in by_expiry if e > event), default=None)
    if after is None:
        return None, None

    contracts = by_expiry[after]
    strikes = {c[2] for c in contracts}
    straddle = None
    for strike in sorted(strikes, key=lambda s: abs(s - price)):
        legs = [c[3] for c in contracts if c[2] == strike and c[3].get("bid", 0) > 0 and c[3].get("ask", 0) > 0]
        if len(legs) == 2:
            straddle = sum((q["bid"] + q["ask"]) / 2 for q in legs) / price
            break

    move = None
    before = max((e for e in by_expiry if as_of < e < event), default=None)
    iv_after = _atm_iv(contracts, price)
    iv_before = _atm_iv(by_expiry[before], price) if before else None
    if iv_after and iv_before:
        jump_variance = (iv_after ** 2 - iv_before ** 2) * (after - as_of).days / 365
        move = math.sqrt(jump_variance) if jump_variance > 0 else None
    return (round(move, 4) if move else None), (round(straddle, 4) if straddle else None)


def surface(contracts, price, as_of, earnings_date=None):
    """
    Shape of the whole chain beyond the one contract the engine reads, recorded for later model training:
      iv30, iv60          constant-maturity at-the-money IV (the market's volatility forecast and its term structure)
      smileDte            days to the expiration nearest 30 days, where the smile below is read
      put10Iv .. call10Iv IV at the 10- and 25-delta puts and calls (skew and tail pricing)
      earningsMove        the earnings-day move implied by the term structure (one standard deviation, fraction of price)
      earningsStraddle    at-the-money straddle of the first expiration after earnings, as a fraction of the price
    Any value the chain can't support is None.
    """
    by_expiry = {}
    for c in contracts:
        if c[0] > as_of:
            by_expiry.setdefault(c[0], []).append(c)
    term = [((e - as_of).days, iv) for e, cs in by_expiry.items() if (iv := _atm_iv(cs, price))]

    smile = {"put10Iv": None, "put25Iv": None, "call25Iv": None, "call10Iv": None}
    smile_expiry = min((e for e in by_expiry if 14 <= (e - as_of).days <= 60), key=lambda e: abs((e - as_of).days - 30), default=None)
    if smile_expiry:
        at = by_expiry[smile_expiry]
        smile = {"put10Iv": _iv_at_delta(at, "P", -0.10), "put25Iv": _iv_at_delta(at, "P", -0.25),
                 "call25Iv": _iv_at_delta(at, "C", 0.25), "call10Iv": _iv_at_delta(at, "C", 0.10)}

    move, straddle = _earnings_move(by_expiry, price, as_of, earnings_date)
    rounded = lambda v: round(v, 4) if v is not None else None
    return {
        "iv30": rounded(_term_iv(term, 30)),
        "iv60": rounded(_term_iv(term, 60)),
        "smileDte": (smile_expiry - as_of).days if smile_expiry else None,
        **{k: rounded(v) for k, v in smile.items()},
        "earningsMove": move,
        "earningsStraddle": straddle,
    }


def summarize_chain(chain, price, as_of, hv30, earnings_date=None):
    """
    chain: Cboe JSON. Returns ATM call metrics for the chosen expiration plus ATM implied volatility,
    IV / 30-day realized volatility ratio, the expected move to expiration, and the chain's surface() (earnings_date,
    ISO, enables its earnings fields). None if no usable contract.
    """
    contracts = []
    for option in chain.get("data", {}).get("options", []):
        parsed = parse_occ(option["option"])
        if parsed:
            contracts.append((*parsed, option))
    expiration = choose_expiration({c[0] for c in contracts}, as_of)
    if expiration is None:
        return None

    at_expiry = [c for c in contracts if c[0] == expiration]
    calls = [c for c in at_expiry if c[1] == "C" and c[3].get("ask", 0) > 0]
    if not calls:
        return None
    _, _, strike, call = min(calls, key=lambda c: abs(c[2] - price))
    put = next((c[3] for c in at_expiry if c[1] == "P" and c[2] == strike), None)

    ivs = [o["iv"] for o in (call, put) if o and o.get("iv", 0) > 0]
    atm_iv = sum(ivs) / len(ivs) if ivs else None
    dte = (expiration - as_of).days

    return {
        "source": "Cboe delayed quotes",
        "quoteTime": chain.get("timestamp"),
        "expiration": expiration.isoformat(),
        "daysToExpiration": dte,
        "atmCallStrike": strike,
        "atmCallBid": call.get("bid"),
        "atmCallAsk": call.get("ask"),
        "atmCallVolume": int(call.get("volume") or 0),
        "atmCallOpenInterest": int(call.get("open_interest") or 0),
        "atmCallDelta": call.get("delta"),
        "atmCallTheta": call.get("theta"),
        "impliedVolatility": round(atm_iv, 4) if atm_iv else None,
        "ivHvRatio": round(atm_iv / hv30, 2) if atm_iv and hv30 else None,
        "expectedMovePct": round(atm_iv * math.sqrt(dte / 365), 4) if atm_iv else None,
        **surface(contracts, price, as_of, earnings_date),
    }
