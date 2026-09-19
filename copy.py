"""
copy.py — auto-copytrade a single FOMO KOL on the ROBINHOOD chain.

WHAT THIS MODULE DOES
    Given a FOMO handle and a buyer's Robinhood private key it:
      1. Resolves the KOL's REAL on-chain EVM wallet via our Impulse backend,
         resolving PAST FOMO's dormant throwaway signer (FOMO's reported
         `evmAddress` holds nothing and never receives the traded tokens — the
         RiseOfDegenOZ bug). Uses `resolvedEvm` only when `evmConfidence` != "none".
      2. Watches that wallet on Robinhood in REAL TIME via a WSS
         eth_subscribe("logs") ERC-20 Transfer subscription (FOMO delivers a
         bought token as a transfer INTO the KOL wallet — the KOL wallet is never
         the tx payer, so there is nothing to watch on the "from my own wallet"
         side; we watch for the token ARRIVING).
      3. On a copyable BUY (a token arriving that is priceable AND worth
         >= the min USD) it buys the same token on Robinhood from the buyer's
         wallet by calling rh.buy(...). Optionally mirrors the KOL's token
         OUTFLOW as a 100% sell (copy_sells=True).

    A real FOMO buy delivered as a bare ERC-20 transfer (NO DEX Swap in the
    delivery tx) is still copied — REQUIRING a Swap in the delivery tx was the
    bug that dropped the MAJORITY of real FOMO buys (verified: 8 of 12 of
    realred's RH buys arrived as bare transfers yet were real, priceable
    tokens). The airdrop/spam filter is _fomo_worth_copying (the token must be
    priceable AND clear the min copy USD) — junk dust drops fail it.

STANDALONE — no Telegram, no database, no fees, no multi-user tables. One KOL
handle -> one buyer wallet. It reuses rh.py for the RH buy/sell engine, RPC
config, raw JSON-RPC helpers and token pricing (rh.py MUST sit alongside this
file — `import rh` has to resolve).

PUBLIC API
    async def copy_fomo_kol(handle, buyer_pk, amount_eth,
                            min_copy_usd=None, copy_sells=False) -> None
    async def resolve_kol_rh_wallet(handle) -> str | None

ENVIRONMENT VARIABLES
    ROBINHOOD_WSS     QuikNode/Alchemy Robinhood WSS url — REQUIRED for the
                      real-time monitor. If unset, this module degrades to a
                      light eth_getLogs poll on the FREE public RH RPC (no
                      metered credits) so copying still works, just a touch slower.
    FOMO_MIN_COPY_USD minimum received USD value to copy a buy (default 25).
    IMPULSE_API_KEY / IMPULSE_API_BASE   Impulse backend auth (defaults baked in,
                      same as main.py so an existing deployment's vars work).
    FOMO_HANDLE / BUYER_PK / COPY_AMOUNT_ETH   used only by __main__.

    All rh.py env vars (ROBINHOOD_RPC, etc.) apply to the buy/sell execution.
"""
from __future__ import annotations

import os
import sys

# This file is named copy.py and lives on sys.path, so it SHADOWS the stdlib
# `copy` module — which requests / eth_account / web3 import transitively (e.g.
# http.cookiejar does `import copy`, eth_account does `from copy import copy`).
# Load the real stdlib `copy` into sys.modules FIRST, with this directory
# temporarily off sys.path, so every later dependency resolves the stdlib one.
if "copy" not in sys.modules:
    _here = os.path.dirname(os.path.abspath(__file__))
    _removed = [p for p in ("", _here, os.getcwd()) if p in sys.path]
    for _p in _removed:
        while _p in sys.path:
            sys.path.remove(_p)
    try:
        import copy as _stdlib_copy   # noqa: F401  registers stdlib copy
    finally:
        sys.path[:0] = _removed

import json
import time
import asyncio
import logging

import requests

import rh                        # sibling engine — MUST be alongside this file
from rh import Web3              # web3 already imported + configured by rh.py

logger = logging.getLogger("copy")

# ---------------------------------------------------------------------------
# Constants copied faithfully from main.py (these encode hard-won fixes).
# ---------------------------------------------------------------------------
# The chain is fixed: this module only copies FOMO KOLs on Robinhood.
_CHAIN = "robinhood"

# The swap MEDIUM on Robinhood — never a copyable token. WETH comes from rh's
# chain registry; RH_USDG is exported by rh.py (fall back to the constant if a
# future rh.py drops it).
_WETH = rh.EVM_CHAINS[_CHAIN]["weth"]
try:
    RH_USDG = rh.RH_USDG
except AttributeError:                              # pragma: no cover
    RH_USDG = Web3.to_checksum_address("0x5fc5360d0400a0fd4f2af552add042d716f1d168")

# ERC-20 Transfer(address,address,uint256) topic0.
_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# Force a WSS log-subscription refresh this often. Providers (QuikNode seen on
# Robinhood) can leave a subscription open-but-silent — a periodic reconnect +
# re-subscribe keeps it live. Free: billing is per-notification, not per-connect.
_WSS_MAX_CONN_SECS = 240

# Filter dust airdrops: a received token must be priceable AND clear this USD
# floor to be worth copying.
_FOMO_MIN_COPY_USD = float(os.environ.get("FOMO_MIN_COPY_USD", "25") or 25)

# The Robinhood WSS endpoint. RH's public RPC has NO WebSocket, so this must be
# a provider (QuikNode/Alchemy) socket. Unset -> the getLogs poll fallback runs.
_ROBINHOOD_WSS = os.environ.get("ROBINHOOD_WSS", "").strip()

_WALLET_TX_SEEN: dict[str, float] = {}   # tx_hash -> ts (dedup: one tx = many logs)


def _addr_topic(addr: str) -> str:
    return "0x" + "0" * 24 + addr.lower().replace("0x", "")


def _seen_wallet_tx(h: str) -> bool:
    now = time.time()
    for k in [k for k, v in _WALLET_TX_SEEN.items() if now - v > 180]:
        _WALLET_TX_SEEN.pop(k, None)
    if h in _WALLET_TX_SEEN:
        return True
    _WALLET_TX_SEEN[h] = now
    return False


# ---------------------------------------------------------------------------
# Impulse FOMO backend — resolve a handle to the trader's REAL EVM wallet.
# ---------------------------------------------------------------------------
IMPULSE_API_BASE = os.environ.get(
    "IMPULSE_API_BASE", "https://backend.getimpulse.online").strip().rstrip("/")
IMPULSE_API_KEY = os.environ.get(
    "IMPULSE_API_KEY",
    "a9ac56c0a3a317d15fb9ed819e91eae4fda25fbe3b15471498928fceb57ebe96").strip()


def _impulse_get(path: str):
    try:
        r = requests.get(IMPULSE_API_BASE + path,
                         headers={"x-api-key": IMPULSE_API_KEY}, timeout=20)
        body = r.json()
        if r.status_code >= 400 or (isinstance(body, dict) and "error" in body):
            logger.info("impulse %s -> %s %s", path[:48], r.status_code,
                        (body.get("error") if isinstance(body, dict) else ""))
            return None
        return body.get("v") if isinstance(body, dict) else None
    except Exception as e:
        logger.info("impulse %s error: %s", path[:48], str(e)[:100])
        return None


def impulse_real_wallet(handle: str) -> dict | None:
    """Resolve a FOMO handle → the trader's REAL on-chain EVM wallet, past FOMO's
    dormant throwaway signer. `/impulse/wallet?handle=` returns
    {resolvedEvm, evmConfidence: high|medium|none, resolvedSol, ...}.
    Returns the `v` payload or None. Callers must treat evmConfidence=="none" /
    resolvedEvm==null as 'no real EVM wallet'."""
    from urllib.parse import quote as _q
    handle = (handle or "").lstrip("@").strip()
    if not handle:
        return None
    return _impulse_get(f"/impulse/wallet?handle={_q(handle)}")


async def resolve_kol_rh_wallet(handle: str) -> str | None:
    """Resolve a FOMO handle → the KOL's REAL EVM wallet address (checksummed),
    the one Robinhood-delivered buys actually land in — NEVER FOMO's dormant
    throwaway `evmAddress`. Returns None when no real EVM wallet is found
    (evmConfidence=="none" / resolvedEvm null)."""
    s = (handle or "").strip()
    if "fomo" in s.lower() and "/" in s:                 # a profile link
        import re
        m = re.search(r"/([^/?#\s]+)/?$", s)
        s = m.group(1) if m else s
    s = s.lstrip("@").strip().strip("/")
    if not s or "/" in s or " " in s:
        return None
    try:
        rw = await asyncio.to_thread(impulse_real_wallet, s)
    except Exception as e:
        logger.info("impulse real-wallet %r: %s", s, str(e)[:80])
        rw = None
    if not isinstance(rw, dict):
        return None
    rev = (rw.get("resolvedEvm") or "").strip()
    # Use resolvedEvm ONLY when a real wallet was found — confidence != "none".
    if rev.startswith("0x") and (rw.get("evmConfidence") or "none").lower() != "none":
        try:
            return Web3.to_checksum_address(rev)
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# Receive-mode detection (FOMO KOLs) — adapted from main.py.
# FOMO KOLs don't swap from their own wallet — a relay buys and DELIVERS the
# token to their wallet (their wallet is never the tx payer). So we can't watch
# for swaps; we watch for the token ARRIVING. A token balance going up = they
# bought it (we copy); going down = they exited (we mirror the sell).
# ---------------------------------------------------------------------------
def _parse_evm_receive(receipt: dict, wallet: str, weth: str
                       ) -> tuple[str, str, float] | None:
    """Largest non-WETH ERC20 moved TO/FROM `wallet`. in=buy, out=sell."""
    try:
        if int(receipt.get("status", "0x1"), 16) != 1:
            return None
        wl = wallet.lower(); wethl = weth.lower()
        deltas: dict = {}     # token -> raw signed delta for the wallet
        for lg in receipt.get("logs", []):
            topics = lg.get("topics") or []
            if not topics or topics[0].lower() != _TRANSFER_TOPIC or len(topics) < 3:
                continue
            token = lg["address"].lower()
            if token == wethl:
                continue
            frm = ("0x" + topics[1][-40:]).lower()
            to = ("0x" + topics[2][-40:]).lower()
            val = int(lg.get("data") or "0x0", 16)
            if to == wl:
                deltas[token] = deltas.get(token, 0) + val
            if frm == wl:
                deltas[token] = deltas.get(token, 0) - val
        if not deltas:
            return None
        token = max(deltas, key=lambda t: abs(deltas[t]))
        d = deltas[token]
        if d == 0:
            return None
        return ("buy" if d > 0 else "sell", Web3.to_checksum_address(token), abs(d) / 1e18)
    except Exception:
        return None


def _fomo_worth_copying(chain: str, token: str, amount_ui: float,
                        min_copy_usd: float = _FOMO_MIN_COPY_USD) -> bool:
    """Filter dust airdrops: only copy a received token that is priceable and
    whose received value clears a small USD floor. Uses rh.get_token_info for
    the price rather than re-implementing pricing."""
    try:
        info = rh.get_token_info(token, chain)
        if not info:
            return False
        px = float(info.get("priceUsd") or 0)
        if px <= 0:
            return False
        if amount_ui and (amount_ui * px) < min_copy_usd:
            return False
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Copy execution — call the rh.py engine from the buyer's wallet.
# ---------------------------------------------------------------------------
async def _replicate_buy(buyer_pk: str, token: str, amount_eth: float) -> None:
    logger.info("copy: BUY %s for %.6f ETH (buyer wallet)", token[:12], amount_eth)
    try:
        ok, tx = await asyncio.to_thread(rh.buy, buyer_pk, token, amount_eth)
    except Exception as e:
        logger.warning("copy buy raised for %s: %s", token[:12], str(e)[:140])
        return
    if ok:
        logger.info("copy: BUY OK %s tx=%s", token[:12], tx)
    else:
        logger.warning("copy: BUY FAILED %s — %s", token[:12], tx)


async def _replicate_sell(buyer_pk: str, token: str) -> None:
    logger.info("copy: SELL 100%% %s (buyer wallet)", token[:12])
    try:
        ok, tx = await asyncio.to_thread(rh.sell, buyer_pk, token, 100)
    except Exception as e:
        logger.warning("copy sell raised for %s: %s", token[:12], str(e)[:140])
        return
    if ok:
        logger.info("copy: SELL OK %s tx=%s", token[:12], tx)
    else:
        logger.warning("copy: SELL FAILED %s — %s", token[:12], tx)


async def _handle_receive(kol_wallet: str, buyer_pk: str, amount_eth: float,
                          min_copy_usd: float, copy_sells: bool,
                          tx_hash: str) -> None:
    """Fetch one tracked delivery tx (FREE public RPC) and replicate it."""
    url = rh._scan_rpc(_CHAIN)
    try:
        receipt = await asyncio.to_thread(
            rh._evm_rpc_at, url, "eth_getTransactionReceipt", [tx_hash])
        if not receipt:
            return
        # FOMO KOL — a relay buys the token and DELIVERS it to the KOL wallet.
        # Depending on the route the delivery tx may carry a DEX Swap event
        # (multi-hop settle) OR be a bare ERC-20 transfer (the swap settled on
        # the relay's own wallet in a separate tx). We used to REQUIRE a Swap
        # in this tx — but that dropped the MAJORITY of real FOMO buys, which
        # arrive as bare transfers (verified: 8 of 12 of realred's RH buys had
        # no Swap yet were real, priceable tokens). So we no longer require a
        # Swap. The airdrop/spam filter is _fomo_worth_copying (token must be
        # priceable AND >= the min copy USD) — junk dust drops fail it. A Swap
        # in the tx is a sufficient signal but no longer necessary.
        parsed = _parse_evm_receive(receipt, kol_wallet, _WETH)
        if not parsed:
            return
        side, token, amount = parsed
        if side == "buy":
            if not await asyncio.to_thread(_fomo_worth_copying, _CHAIN, token,
                                           amount, min_copy_usd):
                logger.info("copy: skip %s (dust/unpriceable, <$%.0f)",
                            token[:12], min_copy_usd)
                return
            logger.info("copy: %s DETECTED buy token=%s → replicating",
                        _CHAIN, token[:12])
            await _replicate_buy(buyer_pk, token, amount_eth)
        else:
            if not copy_sells:
                return
            logger.info("copy: %s DETECTED sell token=%s → replicating",
                        _CHAIN, token[:12])
            await _replicate_sell(buyer_pk, token)
    except Exception as e:
        logger.info("%s receive handle err: %s", _CHAIN, str(e)[:90])


# ---------------------------------------------------------------------------
# Real-time monitor — WSS eth_subscribe("logs") on the KOL wallet.
# Adapted from main.py evm_wallet_logs_monitor for chain="robinhood" ONLY and a
# single tracked wallet. Two Transfer subscriptions (FROM + TO the wallet), a
# periodic re-subscribe every _WSS_MAX_CONN_SECS to keep a QuikNode sub from
# rotting, and the WETH / RH-USDG skip.
# ---------------------------------------------------------------------------
async def _wss_monitor(kol_wallet: str, buyer_pk: str, amount_eth: float,
                       min_copy_usd: float, copy_sells: bool,
                       wss_url: str) -> None:
    import aiohttp
    weth = _WETH
    # Skip the swap MEDIUM (WETH / RH-USDG) — never the copyable token; avoids
    # wasted receipt fetches on stablecoin/native shuffles.
    skip_tokens = {weth.lower(), RH_USDG.lower()}
    wl = kol_wallet.lower()
    topic = _addr_topic(kol_wallet)
    logger.info("Wallet monitor (%s) started — WSS logs subscribe on %s",
                _CHAIN, kol_wallet)
    fails = 0
    while True:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(wss_url, heartbeat=30, max_msg_size=0) as ws:
                    # sub 1: Transfer FROM the KOL wallet (sells + native-in leg)
                    await ws.send_json({"jsonrpc": "2.0", "id": 1, "method": "eth_subscribe",
                                        "params": ["logs", {"topics": [_TRANSFER_TOPIC, [topic]]}]})
                    # sub 2: Transfer TO the KOL wallet (buys + token-in leg)
                    await ws.send_json({"jsonrpc": "2.0", "id": 2, "method": "eth_subscribe",
                                        "params": ["logs", {"topics": [_TRANSFER_TOPIC, None, [topic]]}]})
                    logger.info("%s wallet monitor: subscribed logs for %s",
                                _CHAIN, kol_wallet)
                    fails = 0
                    conn_start = time.time()
                    while True:
                        # A QuikNode (and some providers') log subscription can go
                        # SILENT after a while — the socket stays alive (heartbeat
                        # ok) but stops delivering notifications, so real trades are
                        # never seen (RH FOMO buys silently stopped copying). Force
                        # a fresh reconnect + re-subscribe periodically so the sub
                        # can't rot. Reconnecting is FREE (QuikNode bills per
                        # notification, not per connection), unlike a getLogs poll.
                        if time.time() - conn_start > _WSS_MAX_CONN_SECS:
                            logger.info("%s wallet monitor: refreshing subscription", _CHAIN)
                            break
                        try:
                            msg = await asyncio.wait_for(ws.receive(), timeout=15)
                        except asyncio.TimeoutError:
                            continue
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR,
                                            aiohttp.WSMsgType.CLOSING):
                                break
                            continue
                        data = json.loads(msg.data)
                        if data.get("method") != "eth_subscription":
                            if isinstance(data.get("error"), dict):
                                logger.warning("%s logs subscribe rejected: %s — falling back to public poll",
                                               _CHAIN, str(data["error"])[:120])
                                raise RuntimeError("subscribe-unsupported")
                            continue
                        log = (data.get("params") or {}).get("result") or {}
                        if (log.get("address") or "").lower() in skip_tokens:
                            continue
                        txh = log.get("transactionHash")
                        lt = log.get("topics") or []
                        if not txh or len(lt) < 3:
                            continue
                        frm = ("0x" + lt[1][-40:]).lower()
                        to = ("0x" + lt[2][-40:]).lower()
                        if wl not in (frm, to):
                            continue
                        if _seen_wallet_tx(txh):
                            continue
                        asyncio.create_task(_handle_receive(
                            kol_wallet, buyer_pk, amount_eth, min_copy_usd,
                            copy_sells, txh))
        except asyncio.CancelledError:
            logger.info("Wallet monitor (%s) stopped", _CHAIN); raise
        except RuntimeError as e:
            if "subscribe-unsupported" in str(e):
                # WSS provider doesn't support log subscriptions — degrade to the
                # light getLogs poll on the FREE public RPC (receive-aware, no credits).
                logger.warning("%s: logs unsupported — using free-RPC getLogs poll", _CHAIN)
                await _getlogs_poll(kol_wallet, buyer_pk, amount_eth,
                                    min_copy_usd, copy_sells)
                return
        except Exception as e:
            fails += 1
            logger.warning("%s wallet logs monitor error (%d): %s",
                           _CHAIN, fails, str(e)[:140])
            if fails >= 3:
                logger.warning("%s: WSS unavailable after %d tries — using free-RPC getLogs poll",
                               _CHAIN, fails)
                await _getlogs_poll(kol_wallet, buyer_pk, amount_eth,
                                    min_copy_usd, copy_sells)
                return
        await asyncio.sleep(3)


# ---------------------------------------------------------------------------
# Fallback monitor — light eth_getLogs poll on the FREE public RH RPC.
# Adapted from main.py evm_wallet_getlogs_poll. Used when ROBINHOOD_WSS is unset
# or the provider rejects log subscriptions. One getLogs pair per interval on
# the free public RPC, so it never touches metered QuikNode credits.
# ---------------------------------------------------------------------------
async def _getlogs_poll(kol_wallet: str, buyer_pk: str, amount_eth: float,
                        min_copy_usd: float, copy_sells: bool) -> None:
    logger.info("Wallet monitor (%s) started — getLogs poll (free RPC, receive-aware)", _CHAIN)
    weth = _WETH
    wl = kol_wallet.lower()
    skip_tokens = {weth.lower(), RH_USDG.lower()}
    wtopic = _addr_topic(kol_wallet)
    last: int | None = None
    while True:
        try:
            url = rh._scan_rpc(_CHAIN)                 # FREE public RPC, never QuikNode
            latest_hex = await asyncio.to_thread(rh._evm_rpc_at, url, "eth_blockNumber", [])
            if not latest_hex:
                await asyncio.sleep(3); continue
            latest = int(latest_hex, 16)
            if last is None:
                last = latest - 1                    # start at the tip, no history replay
            frm = max(last + 1, latest - 800)        # cap catch-up window
            if frm > latest:
                await asyncio.sleep(2); continue
            rng = {"fromBlock": hex(frm), "toBlock": hex(latest)}
            logs = []
            rpc_ok = True
            for flt in ([_TRANSFER_TOPIC, [wtopic]],            # Transfer FROM the wallet
                        [_TRANSFER_TOPIC, None, [wtopic]]):     # Transfer TO the wallet
                got = await asyncio.to_thread(rh._evm_rpc_at, url, "eth_getLogs",
                                              [{**rng, "topics": flt}])
                if got is None:        # RPC hiccup/timeout — [] is a valid "no matches"
                    rpc_ok = False
                    break
                logs += got
            if not rpc_ok:
                # Don't advance `last` — RESCAN this window next poll instead of
                # silently skipping it. Advancing the cursor on a failed getLogs
                # used to drop any trade in the gap.
                await asyncio.sleep(2)
                continue
            last = latest
            batch_seen = set()
            for lg in logs:
                if (lg.get("address") or "").lower() in skip_tokens:
                    continue
                txh = lg.get("transactionHash")
                lt = lg.get("topics") or []
                if not txh or len(lt) < 3 or txh in batch_seen:
                    continue
                batch_seen.add(txh)
                frm_a = ("0x" + lt[1][-40:]).lower()
                to_a = ("0x" + lt[2][-40:]).lower()
                if wl not in (frm_a, to_a) or _seen_wallet_tx(txh):
                    continue
                asyncio.create_task(_handle_receive(
                    kol_wallet, buyer_pk, amount_eth, min_copy_usd,
                    copy_sells, txh))
        except asyncio.CancelledError:
            logger.info("Wallet monitor (%s) stopped", _CHAIN); raise
        except Exception as e:
            logger.warning("%s getLogs poll error: %s", _CHAIN, str(e)[:120])
        await asyncio.sleep(2)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def copy_fomo_kol(handle: str, buyer_pk: str, amount_eth: float,
                        min_copy_usd: float | None = None,
                        copy_sells: bool = False) -> None:
    """Resolve `handle`'s real Robinhood wallet, then run the real-time monitor
    loop FOREVER, buying the same token on Robinhood from the buyer's wallet on
    every copyable buy (and selling 100% on the KOL's exit when copy_sells).

    Uses the WSS monitor when ROBINHOOD_WSS is set (REQUIRED for true real-time);
    otherwise degrades to the free-RPC getLogs poll."""
    min_usd = _FOMO_MIN_COPY_USD if min_copy_usd is None else float(min_copy_usd)

    kol_wallet = await resolve_kol_rh_wallet(handle)
    if not kol_wallet:
        logger.error("Could not resolve a real EVM wallet for FOMO handle %r "
                     "(no resolvedEvm / evmConfidence == none). Nothing to copy.",
                     handle)
        return
    logger.info("Copying FOMO KOL %r -> real RH wallet %s (amount=%.6f ETH, "
                "min_copy=$%.0f, copy_sells=%s)",
                handle, kol_wallet, amount_eth, min_usd, copy_sells)

    if _ROBINHOOD_WSS:
        await _wss_monitor(kol_wallet, buyer_pk, amount_eth, min_usd,
                           copy_sells, _ROBINHOOD_WSS)
    else:
        logger.warning("ROBINHOOD_WSS is unset — real-time WSS monitor "
                       "unavailable; using the free-RPC getLogs poll fallback. "
                       "Set ROBINHOOD_WSS to a QuikNode/Alchemy socket for true "
                       "real-time copying.")
        await _getlogs_poll(kol_wallet, buyer_pk, amount_eth, min_usd, copy_sells)


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    # argv: copy.py <handle> <buyer_pk> <amount_eth> [min_copy_usd] [copy_sells]
    argv = sys.argv[1:]
    handle = argv[0] if len(argv) >= 1 else os.environ.get("FOMO_HANDLE", "").strip()
    buyer_pk = argv[1] if len(argv) >= 2 else os.environ.get("BUYER_PK", "").strip()
    amount_raw = argv[2] if len(argv) >= 3 else os.environ.get("COPY_AMOUNT_ETH", "").strip()
    min_raw = argv[3] if len(argv) >= 4 else os.environ.get("FOMO_MIN_COPY_USD", "").strip()
    sells_raw = argv[4] if len(argv) >= 5 else os.environ.get("COPY_SELLS", "").strip()

    if not (handle and buyer_pk and amount_raw):
        sys.stderr.write(
            "usage: python copy.py <fomo_handle> <buyer_private_key> <amount_eth> "
            "[min_copy_usd] [copy_sells]\n"
            "   or set FOMO_HANDLE, BUYER_PK, COPY_AMOUNT_ETH (+ optional "
            "FOMO_MIN_COPY_USD, COPY_SELLS) in the environment.\n")
        sys.exit(2)

    try:
        amount_eth = float(amount_raw)
    except ValueError:
        sys.stderr.write(f"amount_eth must be a number, got {amount_raw!r}\n")
        sys.exit(2)

    min_copy_usd = float(min_raw) if min_raw else None
    copy_sells = str(sells_raw).lower() in ("1", "true", "yes", "on")

    asyncio.run(copy_fomo_kol(handle, buyer_pk, amount_eth,
                              min_copy_usd=min_copy_usd, copy_sells=copy_sells))
