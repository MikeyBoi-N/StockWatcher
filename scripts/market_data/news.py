"""
Recent headlines from Yahoo Finance's per-ticker RSS feed.

The feed mixes in market commentary and articles about other companies, so only headlines that name the ticker or
the company are kept. Each gets a keyword tone: phrases that describe an event (downgrade, raises guidance,
lawsuit), not opinion words, because opinion headlines ("the stock I'd buy today") say nothing about the business.
"""
import re
import xml.etree.ElementTree as ET
from datetime import timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse

LOOKBACK_DAYS = 7
MAX_HEADLINES = 6

_SUFFIXES = re.compile(
    r"\b(inc|incorporated|corp|corporation|co|company|companies|ltd|limited|plc|holdings?|group|n\.v|s\.a|ag|se|"
    r"class [a-c]|common stock|ordinary shares?|american depositary shares?|ads)\b\.?", re.I)
# First words too generic to identify a company alone; those names are matched on their first two words.
_GENERIC_FIRST_WORDS = {
    "advanced", "american", "applied", "bank", "digital", "energy", "eli", "first", "general", "global",
    "international", "micro", "national", "new", "royal", "taiwan", "the", "united",
}

_POSITIVE = [
    r"upgrade[sd]?", r"beats? (?:estimates|expectations|forecasts?)", r"tops (?:estimates|expectations)",
    r"raises? (?:its )?(?:full-year |annual |quarterly )?(?:guidance|outlook|forecast|dividend)",
    r"record (?:revenue|sales|profit|earnings|quarter)", r"surges?", r"soars?", r"jumps?", r"climbs?", r"rises?",
    r"rall(?:y|ies)", r"buybacks?",
    r"share repurchase", r"(?:fda|regulatory) approval", r"wins? (?:a )?(?:contract|deal|approval)",
]
_NEGATIVE = [
    r"downgrade[sd]?", r"miss(?:es|ed) (?:estimates|expectations|forecasts?)", r"falls short",
    r"(?:cuts?|lowers?|slashes) (?:its )?(?:full-year |annual |quarterly )?(?:guidance|outlook|forecast|dividend)",
    r"plunges?", r"tumbles?", r"slumps?", r"sinks?", r"falls?", r"drops?", r"slides?", r"slips?", r"layoffs?", r"job cuts", r"lawsuits?", r"sued", r"probes?",
    r"investigation", r"recalls?", r"bankruptcy", r"fraud", r"antitrust", r"fined", r"(?:equity|share|stock) offering",
    r"short seller",
]
# Speculation ("could surge 233%") describes no event, so phrases right after a modal verb don't count.
_NOT_SPECULATIVE = r"(?<!could )(?<!would )(?<!might )(?<!may )(?<!will )(?<!to )"
_POSITIVE_RE = re.compile(_NOT_SPECULATIVE + r"\b(?:" + "|".join(_POSITIVE) + r")\b", re.I)
_NEGATIVE_RE = re.compile(_NOT_SPECULATIVE + r"\b(?:" + "|".join(_NEGATIVE) + r")\b", re.I)


def company_patterns(ticker, name):
    """Regexes that identify the company in a headline: the ticker (case-sensitive) and its short name."""
    patterns = []
    if len(ticker) >= 2:
        patterns.append(re.compile(rf"(?<![A-Za-z0-9]){re.escape(ticker)}(?![A-Za-z0-9])"))
    words = _SUFFIXES.sub(" ", name.split(" - ")[0]).replace(",", " ").split()
    if words:
        short = words[0] if words[0].lower() not in _GENERIC_FIRST_WORDS and len(words[0]) >= 3 else " ".join(words[:2])
        # "JP Morgan" is usually written "JPMorgan", so two-word names also match without the space.
        for variant in dict.fromkeys([short, short.replace(" ", "")]):
            patterns.append(re.compile(rf"(?<![A-Za-z0-9]){re.escape(variant)}(?![A-Za-z0-9])", re.I))
    return patterns


def headline_tone(title):
    score = len(_POSITIVE_RE.findall(title)) - len(_NEGATIVE_RE.findall(title))
    return "positive" if score > 0 else "negative" if score < 0 else "neutral"


def recent_headlines(rss, ticker, name, as_of, lookback_days=LOOKBACK_DAYS, limit=MAX_HEADLINES):
    """
    rss: raw RSS bytes. as_of: date of the build. Returns
    [{"title", "url", "publisher", "published", "tone"}], newest first, de-duplicated by title.
    """
    patterns = company_patterns(ticker, name)
    cutoff = as_of - timedelta(days=lookback_days)
    by_title = {}
    for item in ET.fromstring(rss).iter("item"):
        title = " ".join((item.findtext("title") or "").split())
        link = (item.findtext("link") or "").strip()
        url = urlparse(link)
        if not title or url.scheme not in ("http", "https") or not any(p.search(title) for p in patterns):
            continue
        try:
            published = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            continue
        if published.tzinfo is None:   # "-0000" offsets parse as naive
            published = published.replace(tzinfo=timezone.utc)
        if published.date() < cutoff or title in by_title:
            continue
        by_title[title] = (published, {
            "title": title,
            "url": link,
            "publisher": url.netloc.removeprefix("www."),
            "published": published.isoformat(),
            "tone": headline_tone(title),
        })
    return [h for _, h in sorted(by_title.values(), key=lambda pair: pair[0], reverse=True)][:limit]
