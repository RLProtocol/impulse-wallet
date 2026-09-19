"""KOL X-Ray — standalone Twitter/X caller scorecard.

Fetches a KOL's tweets over the last N days, extracts every token call
(EVM CA / SOL mint / $CASHTAG), prices each call at its CALL-TIME market cap,
then finds each token's ATH-since-call and current mcap, and produces a
scorecard (win rate, avg/median multiple, best call, etc.).

Extracted verbatim from the StrixBot Telegram bot's /kol scorecard so it can be
reused with NO Telegram, database, userbot, or bot-gating dependency. The
scoring + resolution logic (call-time pricing, cashtag copycat disambiguation,
ATH-since-call) is preserved faithfully — that logic is the whole point.

Public API
----------
    async def score_handle(handle: str, days: int = 7) -> dict
        Thin wrapper over kol_scorecard_payload — score one X handle.

    async def kol_scorecard_payload(handle: str, days: int) -> dict
        Full scorecard dict incl. the X profile.

    def make_app() -> aiohttp.web.Application
        aiohttp app exposing GET/OPTIONS /kol.json?handle=<h>&days=<n>.

    def _render_kol(rep: dict) -> str
        Optional HTML text renderer for a scorecard (Telegram-flavoured).

Env vars
--------
    KOL_TWITTERAPI_KEY   twitterapi.io key for /kol (preferred).
    TWITTERAPI_IO_KEY    fallback twitterapi.io key.
    TWITTERAPI_REST      twitterapi.io base URL (default https://api.twitterapi.io).
    GECKO_API_KEY        optional CoinGecko onchain key (dedicated OHLCV limit).
    GECKO_API_PRO        "1"/"true"/"yes" → use the CoinGecko pro base+header.
    KOL_WEB_SECRET       optional /kol.json auth. Set → ?key= must match; unset → open.
    PORT                 HTTP port for __main__ (default 8080).
"""

import os
import re
import time
import logging
import asyncio
import threading
from datetime import datetime, timezone

import requests
import httpx
import aiohttp
from aiohttp import web

logger = logging.getLogger("kol_xray")

# ── config / keys (same env names as the source bot) ─────────────────────────
TWITTERAPI_IO_KEY = os.environ.get("TWITTERAPI_IO_KEY", "").strip()
TWITTERAPI_REST   = os.environ.get("TWITTERAPI_REST", "https://api.twitterapi.io").strip()

# Shared secret the website's secret page passes as ?key= to /kol.json.
# When set the endpoint requires it; when unset the endpoint is open.
KOL_WEB_SECRET = os.environ.get("KOL_WEB_SECRET", "").strip()
# (handle, days) → (fetched_at, payload). Short TTL so repeat loads are free.
_KOL_WEB_CACHE: dict = {}
_KOL_WEB_TTL = 300

# DexScreener chainId  →  GeckoTerminal network slug.
_GECKO_NET = {
    "solana": "solana", "ethereum": "eth", "base": "base", "bsc": "bsc",
    "robinhood": "robinhood", "arbitrum": "arbitrum", "polygon": "polygon_pos",
    "avalanche": "avax", "optimism": "optimism",
}

# A tweet naming more than this many distinct tokens is treated as a recap /
# watchlist, not a call, and skipped entirely.
KOL_MAX_TICKERS = 3

# Cap how many unique tokens a single scorecard prices. A prolific caller can
# rack up 200+ tokens; pricing them all takes many minutes (each token = several
# OHLCV requests) and hammers the loop. We keep only the most recent N calls.
KOL_MAX_CALLS = 30

# Grading thresholds on the PEAK multiple (peak price ÷ entry price).
KOL_WIN_X     = 2.0   # a "good call": >=2x from the call at some point after
KOL_BANGER_X  = 3.0
KOL_SMALL_X   = 1.3

_EVM_CA_RE   = re.compile(r"0x[a-fA-F0-9]{40}")
_SOL_CA_RE   = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
_CASHTAG_RE  = re.compile(r"\$([A-Za-z][A-Za-z0-9]{1,9})\b")
# Cashtags that are indices / fiat / stables — never memecoin calls.
_CASHTAG_SKIP = {"USD", "USDT", "USDC", "SPX", "SPY", "QQQ", "DXY", "VIX",
                 "BTC", "ETH", "SOL", "BNB"}

# CORS headers for the JSON endpoint.
_DASHBOARD_CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control":                "public, max-age=30",
}


# ── small utilities ──────────────────────────────────────────────────────────
def _kmb(n: float | None) -> str:
    """Compact USD: 1.2B / 340.0k / $5.60."""
    if not n or n <= 0:
        return "?"
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if n >= div:
            return f"{n/div:.2f}{suf}"
    return f"{n:.2f}"


def _tweet_epoch(t: dict) -> int | None:
    """Parse twitterapi.io createdAt ('Wed Oct 25 12:34:56 +0000 2023')."""
    s = t.get("createdAt") or t.get("created_at") or ""
    if not s:
        return None
    try:
        return int(datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y").timestamp())
    except Exception:
        try:  # ISO fallback
            return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
        except Exception:
            return None


# ── twitterapi.io client + fetch ─────────────────────────────────────────────
# Dedicated twitterapi.io key for /kol only. Falls back to the tracker key when
# present, but on strix-bot (which has no tracker key) you set KOL_TWITTERAPI_KEY
# alone. Its own httpx client, independent of anything else.
_kol_http = None


def _kol_key() -> str:
    return (os.environ.get("KOL_TWITTERAPI_KEY", "").strip()
            or (TWITTERAPI_IO_KEY or "").strip())


async def _kol_x_get(path: str, params: dict) -> dict:
    global _kol_http
    if _kol_http is None:
        _kol_http = httpx.AsyncClient(
            base_url=TWITTERAPI_REST,
            headers={"x-api-key": _kol_key()},
            timeout=httpx.Timeout(connect=15, read=45, write=15, pool=15))
    last = None
    for attempt in range(3):  # twitterapi.io occasionally times out; retry
        try:
            resp = await _kol_http.request("GET", path, params=params)
            resp.raise_for_status()
            return resp.json()
        except (httpx.TimeoutException, httpx.TransportError) as e:
            last = e
            await asyncio.sleep(1.5 * (attempt + 1))
    raise last if last else RuntimeError("x_get failed")


async def kol_validate_handle(handle: str) -> tuple[dict | None, str | None]:
    handle = handle.lstrip("@").strip()
    try:
        data = await _kol_x_get("/twitter/user/info", {"userName": handle})
    except Exception as e:
        logger.warning("kol_validate_handle(%s) failed: %r", handle, e)
        return None, "Couldn't reach X right now. Try again in a moment."
    user = data.get("data")
    if not user or not user.get("id"):
        return None, f"@{handle} doesn't exist on X."
    return user, None


async def x_fetch_user_tweets(handle: str, since_ts: int,
                              max_pages: int = 12) -> list[dict]:
    """All of @handle's tweets (incl. replies, excl. retweets) since since_ts.
    Uses twitterapi.io advanced search, paginated by cursor."""
    handle = handle.lstrip("@").strip()
    # NOTE: twitterapi.io's advanced_search HANGS when a `since:` operator is in
    # the query. So we query plain `from:handle` (newest-first) and cut off
    # client-side once tweets fall before since_ts. Retweets are skipped in
    # analyze_kol (a RT of someone else's call isn't this KOL's call).
    query = f"from:{handle}"
    out: list[dict] = []
    cursor = ""
    for _ in range(max_pages):
        params = {"query": query, "queryType": "Latest"}
        if cursor:
            params["cursor"] = cursor
        try:
            data = await _kol_x_get("/twitter/tweet/advanced_search", params)
        except Exception as e:
            logger.warning("kol: advanced_search failed: %s", e)
            break
        tweets = data.get("tweets") or data.get("data") or []
        if not tweets:
            break
        out.extend(tweets)
        # Stop early once we've paged past the window.
        oldest = min((_tweet_epoch(t) or since_ts) for t in tweets)
        if oldest < since_ts:
            break
        if not data.get("has_next_page"):
            break
        cursor = data.get("next_cursor") or ""
        if not cursor:
            break
        await asyncio.sleep(0.4)  # gentle pacing
    return out


# ── call extraction ──────────────────────────────────────────────────────────
def _kol_extract(text: str) -> list[tuple[str, str]]:
    """Return [(kind, raw)] mentions: kind in {'evm','sol','tag'}."""
    found: list[tuple[str, str]] = []
    for m in _EVM_CA_RE.findall(text):
        found.append(("evm", m.lower()))
    # SOL: strip out anything already matched as evm / inside a url handled by regex boundaries
    for m in _SOL_CA_RE.findall(text):
        if m.startswith("0x") or len(m) < 32:
            continue
        found.append(("sol", m))
    for m in _CASHTAG_RE.findall(text):
        if m.upper() in _CASHTAG_SKIP:
            continue
        found.append(("tag", m.upper()))
    return found


# ── DexScreener token resolution + pricing ───────────────────────────────────
def _ds_get(url: str, params: dict | None = None, tries: int = 4) -> dict | None:
    """DexScreener GET with 429 backoff. Resolution fires ~20 calls in a burst;
    without retries a rate-limited window silently zeroes the whole scorecard."""
    for a in range(tries):
        try:
            r = requests.get(url, params=params, timeout=10)
        except Exception:
            time.sleep(0.6 * (a + 1))
            continue
        if r.status_code == 429:
            ra = r.headers.get("Retry-After", "")
            time.sleep(float(ra) if ra.replace(".", "", 1).isdigit() else 1.2 * (a + 1))
            continue
        if r.status_code != 200:
            return None
        try:
            return r.json()
        except Exception:
            return None
    return None


def _ds_best_pair_anychain(token: str) -> dict | None:
    """Deepest DexScreener pair for a CA across ALL chains (chain-agnostic)."""
    j = _ds_get(f"https://api.dexscreener.com/latest/dex/tokens/{token}")
    pairs = (j or {}).get("pairs") or []
    if not pairs:
        return None
    return max(pairs, key=lambda p: float((p.get("liquidity") or {}).get("usd") or 0))


def _pair_social_handles(pair: dict) -> set[str]:
    """X/Twitter handles listed in a DexScreener pair's socials (lowercased)."""
    info = pair.get("info") or {}
    handles: set[str] = set()
    for s in (info.get("socials") or []):
        u = (s.get("url") or "").lower()
        m = re.search(r"(?:x|twitter)\.com/([a-z0-9_]{1,15})", u)
        if m:
            handles.add(m.group(1))
    return handles


def _liq(p: dict) -> float:
    try:
        return float((p.get("liquidity") or {}).get("usd") or 0)
    except (TypeError, ValueError):
        return 0.0


def _pair_activity_score(p: dict) -> tuple:
    """Rank candidates by HARD-TO-FAKE activity, not reported liquidity.

    A copycat can show a fat liquidity.usd that's fake — the pool holds almost
    no real quote (e.g. 0.00001 ETH) against a worthless token side priced up to
    look like millions — yet it has ~zero real trading. So we rank by 24h volume
    and txn count first (real activity), and only use liquidity.usd as a final
    tiebreak."""
    try:
        vol = float((p.get("volume") or {}).get("h24") or 0)
    except (TypeError, ValueError):
        vol = 0.0
    tx = (p.get("txns") or {}).get("h24") or {}
    ntx = (tx.get("buys") or 0) + (tx.get("sells") or 0)
    return (vol, ntx, _liq(p))


def _cand_score(p: dict, call_ts: int | None = None) -> tuple:
    """Rank a same-symbol candidate token, most-decisive signal first:
      1. EXISTED at the call — a pool created AFTER the call can't be what was
         called, so a copycat that launched later is ranked below the real one
         even if it now has more volume (the real token often goes quiet later).
      2. Has real socials (legit project vs anonymous copycat).
      3. Real activity: 24h volume, then txns. Never reported liquidity, which
         copycats fake.
    A 6h grace on (1) covers calling a token right as its pool is indexed."""
    existed = 1
    created = p.get("pairCreatedAt")
    if call_ts and created:
        try:
            existed = 1 if (float(created) / 1000.0) <= (call_ts + 21600) else 0
        except (TypeError, ValueError):
            existed = 1
    socials = 1 if ((p.get("info") or {}).get("socials")) else 0
    return (existed, socials) + _pair_activity_score(p)


def _ds_search_cashtag(ticker: str, mentions: set[str] | None = None,
                       call_ts: int | None = None) -> dict | None:
    """Resolve $TICKER → the right pair.

    Cashtags are ambiguous — scam/copycats reuse a ticker, show fake liquidity,
    and even relaunch after a call. Signals, strongest first:
      1. If the calling tweet @mentions the project account, match that handle
         against each candidate's DexScreener social handle (e.g. $SZR +
         @SazareProtocol → the token that lists x.com/SazareProtocol).
      2. Otherwise rank by _cand_score: pool existed at the call time, then real
         socials, then real trading activity — NOT reported liquidity."""
    j = _ds_get("https://api.dexscreener.com/latest/dex/search", {"q": ticker})
    pairs = (j or {}).get("pairs") or []
    exact = [p for p in pairs
             if (p.get("baseToken", {}).get("symbol") or "").upper() == ticker.upper()]
    if not exact:
        return None
    # 1) strongest signal: official social == a handle the tweet @mentioned.
    if mentions:
        matched = [p for p in exact if _pair_social_handles(p) & mentions]
        if matched:
            return max(matched, key=lambda p: _cand_score(p, call_ts))
    # 2) existed-at-call → socials → activity (never fake liquidity).
    return max(exact, key=lambda p: _cand_score(p, call_ts))


def _token_pools(ca: str, ds_chain: str) -> list[str]:
    """All pool addresses for a token on a chain, best-activity first.
    Pricing falls back through these when the top pool has no OHLCV."""
    j = _ds_get(f"https://api.dexscreener.com/latest/dex/tokens/{ca}")
    pairs = [p for p in ((j or {}).get("pairs") or [])
             if p.get("chainId") == ds_chain
             and ((p.get("baseToken") or {}).get("address") or "").lower() == ca.lower()
             and p.get("pairAddress")]
    return [p["pairAddress"]
            for p in sorted(pairs, key=_pair_activity_score, reverse=True)]


def _resolve_call(kind: str, raw: str, mentions: set[str] | None = None,
                  call_ts: int | None = None) -> dict | None:
    """(kind, raw) → {ca, chain_ds, gecko_net, pool, symbol, price_usd, mcap}.
    `mentions` are the @handles from the calling tweet and `call_ts` its time —
    both used to disambiguate cashtags against copycats (via DexScreener socials
    and pool-existed-at-call)."""
    pair = (_ds_search_cashtag(raw, mentions, call_ts) if kind == "tag"
            else _ds_best_pair_anychain(raw))
    if not pair:
        return None
    ca = (pair.get("baseToken", {}) or {}).get("address")
    ds_chain = pair.get("chainId") or ""
    gnet = _GECKO_NET.get(ds_chain)
    if not ca or not gnet:
        return None
    try:
        price_usd = float(pair.get("priceUsd") or 0)
    except (TypeError, ValueError):
        price_usd = 0.0
    # ALL of this token's pools on this chain, best-activity first. Pricing walks
    # this list until one pool yields data — a single pool can lack GeckoTerminal
    # coverage or transiently fail, which would otherwise zero the whole token.
    pools = _token_pools(ca, ds_chain)
    if pair.get("pairAddress") and pair["pairAddress"] not in pools:
        pools = [pair["pairAddress"]] + pools
    if not pools:
        pools = [pair.get("pairAddress")]
    return {
        "ca": ca, "chain_ds": ds_chain, "gecko_net": gnet,
        "pool": pools[0], "pools": pools,
        "symbol": (pair.get("baseToken", {}) or {}).get("symbol") or "?",
        "name": (pair.get("baseToken", {}) or {}).get("name") or "",
        "logo": (pair.get("info") or {}).get("imageUrl") or "",
        "price_usd": price_usd,
        "mcap": pair.get("marketCap") or pair.get("fdv"),
    }


# OHLCV source. The public GeckoTerminal pool (no key) is shared and 429s hard
# (~12s/call effective after backoffs). A CoinGecko key hits the SAME data on a
# DEDICATED limit — demo (free) = 30/min, pro = 500/min — via the identical
# /networks/{net}/pools/{pool}/ohlcv/{tf} path, just a different base + header.
GECKO_API_KEY = os.environ.get("GECKO_API_KEY", "").strip()
GECKO_API_PRO = os.environ.get("GECKO_API_PRO", "").strip().lower() in ("1", "true", "yes")
if GECKO_API_KEY:
    _GECKO_BASE = ("https://pro-api.coingecko.com/api/v3/onchain" if GECKO_API_PRO
                   else "https://api.coingecko.com/api/v3/onchain")
    _GECKO_HDR = {"Accept": "application/json",
                  ("x-cg-pro-api-key" if GECKO_API_PRO else "x-cg-demo-api-key"): GECKO_API_KEY}
    _GECKO_MIN_GAP = 0.14 if GECKO_API_PRO else 2.1   # 500/min vs 30/min
else:
    _GECKO_BASE = "https://api.geckoterminal.com/api/v2"
    _GECKO_HDR = {"Accept": "application/json"}
    _GECKO_MIN_GAP = 2.2

# Serialize every OHLCV call through one lock + a minimum gap, then retry 429s.
_GECKO_LOCK = threading.Lock()
_gecko_last = [0.0]


def _gecko_ohlcv(net: str, pool: str, tf: str, before_ts: int,
                 limit: int, ca: str | None = None) -> list[list]:
    """Raw OHLCV list (newest-first): [[ts,o,h,l,c,v], ...]. Rate-limit safe.

    `ca` is REQUIRED for correctness: without &token=<ca> the endpoint prices
    the pool in its default orientation — usually the OTHER side of the pair —
    which silently returns a wildly wrong price (e.g. 109 instead of 0.04) for
    any pool where our token isn't the 'base' side."""
    url = (f"{_GECKO_BASE}/networks/{net}/pools/{pool}"
           f"/ohlcv/{tf}?aggregate=1&before_timestamp={before_ts}"
           f"&limit={limit}&currency=usd")
    if ca:
        url += f"&token={ca}"
    with _GECKO_LOCK:
        for attempt in range(5):
            gap = _GECKO_MIN_GAP - (time.time() - _gecko_last[0])
            if gap > 0:
                time.sleep(gap)
            try:
                r = requests.get(url, timeout=20, headers=_GECKO_HDR)
            except Exception:
                _gecko_last[0] = time.time()
                return []
            _gecko_last[0] = time.time()
            if r.status_code == 429:
                ra = r.headers.get("Retry-After", "")
                time.sleep(float(ra) if ra.replace(".", "", 1).isdigit()
                           else 2.5 * (attempt + 1))
                continue
            if r.status_code != 200:
                return []
            try:
                return (((r.json() or {}).get("data") or {})
                        .get("attributes", {}) or {}).get("ohlcv_list") or []
            except Exception:
                return []
    return []


def _price_at(net: str, pool: str, ts: int,
              ca: str | None = None) -> float | None:
    """Price at the MOMENT of the call = OPEN of the candle that contains it.

    Callers quote the price when they post (the minute's open). Using the close
    — or, as before, the close of the minute AFTER the call (ts+90) — badly
    overshoots on fast movers: a pump.fun token can 2x within the call minute,
    so a 5k call would read as ~11k. Anchoring to the containing candle's open
    fixes that. Minute → hour → day."""
    for tf, period in (("minute", 60), ("hour", 3600), ("day", 86400)):
        before = (ts // period) * period + period - 1   # last sec of call period
        rows = _gecko_ohlcv(net, pool, tf, before, 1, ca)
        if rows and float(rows[0][1] or 0) > 0:          # index 1 = open
            return float(rows[0][1])
        time.sleep(0.2)
    return None


def _peak_since(net: str, pool: str, since_ts: int,
                ca: str | None = None) -> float | None:
    """Highest high across candles from since_ts → now."""
    now = int(time.time())
    span = now - since_ts
    tf, limit = ("hour", 400) if span <= 400 * 3600 else ("day", 400)
    rows = _gecko_ohlcv(net, pool, tf, now + 3600, limit, ca)
    highs = [float(r[2]) for r in rows
             if len(r) >= 3 and int(r[0]) >= since_ts - 3600 and float(r[2] or 0) > 0]
    return max(highs) if highs else None


def _grade(peak_x: float | None) -> tuple[str, str]:
    if peak_x is None:
        return "⚫", "no data"
    if peak_x >= KOL_BANGER_X:
        return "🟢", "banger"
    if peak_x >= KOL_WIN_X:
        return "🟢", "good"
    if peak_x >= KOL_SMALL_X:
        return "⚪", "small"
    return "🔴", "flat/dump"


# ── scoring engine ───────────────────────────────────────────────────────────
def _score_posts(posts: list[dict], days: int) -> dict:
    """Source-agnostic scoring engine. posts = [{ts, id, found, ats}] where
    `found` is the already-extracted [(kind, raw)] mentions and `ats` the @handles.
    Resolves + prices the EARLIEST mention of each token. Used by the X (tweets)
    scorecard."""
    since_ts = int(time.time()) - days * 86400
    first_seen: dict[tuple[str, str], int] = {}
    first_pid: dict[tuple[str, str], str] = {}
    first_ats: dict[tuple[str, str], set[str]] = {}
    counts: dict[tuple[str, str], int] = {}
    for p in posts:
        ts = p.get("ts")
        if ts is None or ts < since_ts:
            continue
        pid = str(p.get("id") or "")
        ats = p.get("ats") or set()
        for kind, raw in (p.get("found") or []):
            key = (kind, raw)
            counts[key] = counts.get(key, 0) + 1
            if key not in first_seen or ts < first_seen[key]:
                first_seen[key] = ts
                first_pid[key] = pid
                first_ats[key] = ats

    logger.info("kol: %d raw mentions to resolve", len(first_seen))
    tokens: dict[str, dict] = {}
    for (kind, raw), ts in first_seen.items():
        info = _resolve_call(kind, raw, first_ats.get((kind, raw)), ts)
        if not info:
            continue
        cak = info["ca"].lower()
        cur = tokens.get(cak)
        pid = first_pid.get((kind, raw), "")
        if not cur:
            tokens[cak] = {**info, "call_ts": ts, "post_id": pid,
                           "mentions": counts[(kind, raw)], "labels": {raw}}
        else:
            cur["mentions"] += counts[(kind, raw)]
            cur["labels"].add(raw)
            if ts < cur["call_ts"]:
                cur["call_ts"] = ts
                cur["post_id"] = pid

    # Keep only the most recent KOL_MAX_CALLS unique tokens — pricing every one
    # of a 200+ call history grinds for minutes. Recent calls are what matter.
    if len(tokens) > KOL_MAX_CALLS:
        keep = sorted(tokens.items(), key=lambda kv: kv[1]["call_ts"],
                      reverse=True)[:KOL_MAX_CALLS]
        logger.info("kol: capping %d tokens → most recent %d",
                    len(tokens), KOL_MAX_CALLS)
        tokens = dict(keep)

    logger.info("kol: resolved %d unique tokens, pricing…", len(tokens))
    calls = []
    for _i, (cak, tk) in enumerate(tokens.items()):
        if _i and _i % 4 == 0:
            logger.info("kol: priced %d/%d tokens", _i, len(tokens))
        # Walk the token's pools (best-activity first) until one yields both an
        # entry AND a peak. Guards against a single pool lacking OHLCV coverage.
        net = tk["gecko_net"]
        entry = peak = None
        for _pool in (tk.get("pools") or [tk.get("pool")])[:3]:
            if not _pool:
                continue
            e = _price_at(net, _pool, tk["call_ts"], tk["ca"])
            if e is None:
                continue
            pk = _peak_since(net, _pool, tk["call_ts"], tk["ca"])
            if pk is None:
                if entry is None:
                    entry = e
                continue
            entry, peak = e, pk
            break
        cur_price = tk["price_usd"] or 0.0
        peak_x = (peak / entry) if (entry and peak) else None
        now_x  = (cur_price / entry) if (entry and cur_price) else None
        cur_mcap = float(tk["mcap"]) if tk["mcap"] else None
        entry_mcap = (cur_mcap * entry / cur_price) if (cur_mcap and cur_price and entry) else None
        peak_mcap  = (cur_mcap * peak  / cur_price) if (cur_mcap and cur_price and peak)  else None
        # Sanity net: a token we track being worth tens of billions means broken
        # OHLCV (bad pool orientation / garbage candle) — drop it rather than
        # surface an absurd mcap.
        if (entry_mcap or 0) > 5e10 or (peak_mcap or 0) > 5e10:
            peak_x = now_x = entry_mcap = peak_mcap = None
        emoji, label = _grade(peak_x)
        calls.append({
            "symbol": tk["symbol"], "name": tk.get("name", ""),
            "logo": tk.get("logo", ""), "ca": tk["ca"], "chain": tk["chain_ds"],
            "call_ts": tk["call_ts"], "post_id": tk.get("post_id", ""),
            "tweet_id": tk.get("post_id", ""), "post_url": "",
            "mentions": tk["mentions"],
            "entry_mcap": entry_mcap, "peak_mcap": peak_mcap, "cur_mcap": cur_mcap,
            "peak_x": peak_x, "now_x": now_x, "emoji": emoji, "label": label,
        })

    scored = [c for c in calls if c["peak_x"] is not None]
    wins   = [c for c in scored if c["peak_x"] >= KOL_WIN_X]
    scored.sort(key=lambda c: c["peak_x"], reverse=True)
    calls.sort(key=lambda c: (c["peak_x"] is None, -(c["peak_x"] or 0)))
    avg_x  = sum(c["peak_x"] for c in scored) / len(scored) if scored else None
    med_x  = sorted(c["peak_x"] for c in scored)[len(scored)//2] if scored else None
    return {
        "days": days, "scanned": len(posts),
        "calls_found": len(calls), "with_data": len(scored),
        "win_rate": (len(wins) / len(scored)) if scored else None,
        "wins": len(wins), "avg_x": avg_x, "med_x": med_x,
        "best": scored[0] if scored else None,
        "worst": scored[-1] if scored else None,
        "calls": calls,
    }


def analyze_kol(handle: str, days: int, tweets: list[dict]) -> dict:
    """X scorecard: build posts from tweets (skip retweets, recaps, self-quote
    updates; extract @mentions), then score."""
    since_ts = int(time.time()) - days * 86400
    posts = []
    for t in tweets:
        ts = _tweet_epoch(t)
        if ts is None or ts < since_ts:
            continue
        text = t.get("text") or ""
        if text.startswith("RT @") or t.get("retweeted_tweet"):
            continue
        found = _kol_extract(text)
        if len(set(found)) > KOL_MAX_TICKERS:   # recap / watchlist post
            continue
        q = t.get("quoted_tweet") or t.get("quotedTweet")
        if isinstance(q, dict):
            q_author = ((q.get("author") or {}).get("userName") or "").lower()
            q_ts = _tweet_epoch(q)
            if q_author == handle.lower() and q_ts is not None and q_ts < since_ts:
                shared = set(found) & set(_kol_extract(q.get("text") or ""))
                if shared:
                    found = [x for x in found if x not in shared]
        ats = {m.lower() for m in re.findall(r"@([A-Za-z0-9_]{1,15})", text)}
        posts.append({"ts": ts, "id": str(t.get("id") or t.get("id_str") or ""),
                      "found": found, "ats": ats})
    rep = _score_posts(posts, days)
    for c in rep["calls"]:
        c["post_url"] = (f"https://x.com/{handle}/status/{c['post_id']}"
                         if c.get("post_id") else "")
    rep["handle"] = handle
    rep["tweets_scanned"] = rep["scanned"]   # kept for _render_kol
    return rep


# ── optional text renderer ───────────────────────────────────────────────────
def _render_kol(rep: dict) -> str:
    """Render a scorecard as HTML text (Telegram-flavoured). Optional — the JSON
    payload from kol_scorecard_payload is the primary output."""
    prof = rep.get("profile") or {}
    src  = prof.get("source", "x")
    if src == "tg":
        title   = f"📊 <b>Channel Scorecard — {prof.get('name', '?')}</b>"
        scanned = f"{rep.get('scanned', 0)} posts scanned"
    else:
        who     = prof.get("username") or rep.get("handle", "?")
        title   = f"📊 <b>KOL Scorecard — @{who}</b>"
        scanned = f"{rep.get('scanned', rep.get('tweets_scanned', 0))} tweets scanned"
    L = [title,
         f"Window: last {rep['days']}d · {scanned}",
         f"Calls: <b>{rep['calls_found']}</b> · with price data: {rep['with_data']}",
         ""]
    if rep["with_data"]:
        wr = rep["win_rate"] or 0
        L.append(f"🏆 <b>Win rate</b> (≥{KOL_WIN_X:g}x peak): "
                 f"<b>{wr*100:.0f}%</b> ({rep['wins']}/{rep['with_data']})")
        if rep["avg_x"] is not None:
            L.append(f"📈 Avg peak: <b>{rep['avg_x']:.1f}x</b> · "
                     f"Median: {rep['med_x']:.1f}x")
        b, w = rep["best"], rep["worst"]
        if b:
            L.append(f"🟢 Best: ${b['symbol']} <b>{b['peak_x']:.1f}x</b>  ·  "
                     f"🔴 Worst: ${w['symbol']} {w['peak_x']:.2f}x")
        L.append("")
        L.append("<b>Calls</b>  (entry → ATH → now · tap the CA for the chart):")
        for c in rep["calls"][:20]:
            when = datetime.fromtimestamp(c["call_ts"], tz=timezone.utc).strftime("%b %d")
            ca   = c.get("ca", "")
            dex  = f"https://dexscreener.com/{c.get('chain','')}/{ca}"
            shortca = (ca[:6] + "…" + ca[-4:]) if len(ca) > 12 else ca
            ca_link = f'<a href="{dex}">{shortca}</a>'
            if c["peak_x"] is None:
                L.append(f"⚫ <b>${c['symbol']}</b> — no price data · {ca_link} · {when}")
                continue
            L.append(
                f"{c['emoji']} <b>${c['symbol']}</b>  <b>{c['peak_x']:.1f}x</b>"
                f"  ·  Entry {_kmb(c['entry_mcap'])} · ATH {_kmb(c['peak_mcap'])} · "
                f"Now {_kmb(c['cur_mcap'])}\n"
                f"    {ca_link} · {when}")
        if len(rep["calls"]) > 20:
            L.append(f"…and {len(rep['calls'])-20} more")
    else:
        L.append("No tokens with price data were found in this window.")
    return "\n".join(L)


# ── primary entry point ──────────────────────────────────────────────────────
async def kol_scorecard_payload(handle: str, days: int) -> dict:
    """Full scorecard dict incl. X profile — shared by /kol.json (web)."""
    user, err = await kol_validate_handle(handle)
    if err:
        return {"ok": False, "error": err}
    profile = {
        "source":   "x",
        "name":     user.get("name") or handle,
        "username": user.get("userName") or handle,
        "avatar":   user.get("profilePicture") or "",
        "followers": user.get("followers") or user.get("followersCount") or 0,
        "verified": bool(user.get("isBlueVerified") or user.get("verified")),
        "description": user.get("description") or "",
    }
    since_ts = int(time.time()) - days * 86400
    _t0 = time.time()
    logger.info("kol: %s fetching last %dd", handle, days)
    tweets = await x_fetch_user_tweets(handle, since_ts)
    logger.info("kol: %s got %d tweets in %.0fs, scoring…",
                handle, len(tweets), time.time() - _t0)
    _t1 = time.time()
    rep = await asyncio.to_thread(analyze_kol, handle, days, tweets)
    logger.info("kol: %s scored %s calls (%s priced) in %.0fs",
                handle, rep.get("calls_found"), rep.get("with_data"),
                time.time() - _t1)
    rep["ok"] = True
    rep["profile"] = profile
    rep["generated_at"] = int(time.time())
    # NOTE: the original bot recorded every run into a KOL leaderboard here.
    # Dropped in this standalone extraction — no leaderboard/DB dependency.
    return rep


async def score_handle(handle: str, days: int = 7) -> dict:
    """Thin public wrapper over kol_scorecard_payload — score one X handle."""
    handle = (handle or "").lstrip("@").strip()
    days = max(1, min(14, int(days)))
    return await kol_scorecard_payload(handle, days)


# ── HTTP endpoint ────────────────────────────────────────────────────────────
async def _kol_json_handler(request):
    """JSON for the website's KOL scorecard page. CORS=*.

    Auth: when KOL_WEB_SECRET is set, ?key= must match it; when unset, the
    endpoint is open (each call still costs twitterapi.io credits)."""
    if KOL_WEB_SECRET and request.query.get("key") != KOL_WEB_SECRET:
        return web.json_response({"ok": False, "error": "unauthorized"},
                                 status=401, headers=_DASHBOARD_CORS)
    if not _kol_key():
        return web.json_response({"ok": False, "error": "X API key not set"},
                                 status=503, headers=_DASHBOARD_CORS)
    handle = (request.query.get("handle") or "").lstrip("@").strip()
    if not re.match(r"^[A-Za-z0-9_]{1,15}$", handle):
        return web.json_response({"ok": False, "error": "invalid handle"},
                                 status=400, headers=_DASHBOARD_CORS)
    try:
        days = max(1, min(14, int(request.query.get("days", "7"))))
    except ValueError:
        days = 7
    ckey = (handle.lower(), days)
    cached = _KOL_WEB_CACHE.get(ckey)
    if cached and (time.time() - cached[0]) < _KOL_WEB_TTL:
        return web.json_response(cached[1], headers=_DASHBOARD_CORS)
    try:
        payload = await kol_scorecard_payload(handle, days)
    except Exception as e:
        logger.error("kol.json failed for %s: %s", handle, e, exc_info=True)
        return web.json_response({"ok": False, "error": "scorecard failed"},
                                 status=500, headers=_DASHBOARD_CORS)
    if payload.get("ok"):
        _KOL_WEB_CACHE[ckey] = (time.time(), payload)
    return web.json_response(payload, headers=_DASHBOARD_CORS)


async def _kol_json_options(request):
    return web.Response(status=204, headers=_DASHBOARD_CORS)


def make_app() -> web.Application:
    """aiohttp app exposing GET/OPTIONS /kol.json?handle=<h>&days=<n>."""
    app = web.Application()
    app.router.add_get("/kol.json", _kol_json_handler)
    app.router.add_options("/kol.json", _kol_json_options)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(make_app(), port=int(os.environ.get("PORT", "8080")))
