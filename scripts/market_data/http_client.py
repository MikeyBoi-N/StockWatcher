"""Polite JSON-over-HTTP client: per-host throttling, gzip, and retries on transient failures (stdlib only)."""
import gzip
import json
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class FetchError(Exception):
    pass


class HttpClient:
    """
    min_interval_by_host: seconds to wait between requests to the same host (e.g. SEC allows 10 req/s).
    """

    def __init__(self, min_interval_by_host=None, default_interval=0.3, retries=3, timeout=60):
        self.min_interval_by_host = min_interval_by_host or {}
        self.default_interval = default_interval
        self.retries = retries
        self.timeout = timeout
        self._host_locks = {}
        self._host_last = {}
        self._registry_lock = threading.Lock()

    def _throttle(self, host):
        with self._registry_lock:
            lock = self._host_locks.setdefault(host, threading.Lock())
        with lock:
            interval = self.min_interval_by_host.get(host, self.default_interval)
            wait = self._host_last.get(host, 0) + interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._host_last[host] = time.monotonic()

    def get_json(self, url, headers=None):
        body = self.get_bytes(url, headers)
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            raise FetchError(f"response was not JSON for {url}") from None

    def get_bytes(self, url, headers=None, accept="application/json"):
        host = urlparse(url).netloc
        request_headers = {"User-Agent": BROWSER_UA, "Accept": accept, "Accept-Encoding": "gzip"}
        request_headers.update(headers or {})

        last_error = None
        for attempt in range(self.retries):
            self._throttle(host)
            try:
                request = urllib.request.Request(url, headers=request_headers)
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read()
                    if response.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                return body
            except urllib.error.HTTPError as err:
                last_error = f"HTTP {err.code}"
                if err.code not in RETRYABLE_STATUS:
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                last_error = f"network error: {err}"
            time.sleep(2 ** attempt)
        raise FetchError(f"{last_error} for {url}")
