"""
robinhoodcode.py — self-contained Robinhood Chain trading toolkit.
================================================================================
READ THIS FIRST (orientation for humans and AI agents)
================================================================================

WHAT THIS IS
    A standalone, importable Python module with everything needed to trade on
    Robinhood Chain (an Arbitrum-style EVM L2, chainId 4663, native gas = ETH).
    It was extracted verbatim from a larger Telegram trading bot (main.py) so a
    new, dedicated Robinhood-Chain app can be built on top of it. main.py is the
    original; this file is a COPY plus its full dependency tree, so it runs on
    its own. Pure on-chain logic only — no Telegram, no database, no bookkeeping.

    It also carries the `eth` and `base` chains because RH shares the same EVM
    plumbing with them; pass chain="robinhood" for RH.

THE PUBLIC API (what a new app calls)
    Sending ETH
        evm_send(pk_hex, to_addr, amount_eth, chain="robinhood") -> (ok, tx|err)
    Balances
        get_evm_balance(addr, chain)                 -> float (native ETH)
        get_evm_token_balance(wallet, token, chain)  -> float (whole tokens)
        get_evm_token_balance_raw(wallet, token, chain) -> int (wei-scale)
    Trading ANY Uniswap pool (auto-detects V2 / V3 / V4 and routes)
        evm_buy_tokens(pk_hex, token, amount_eth, chain="robinhood")  -> (ok, tx|err)
        evm_sell_tokens(pk_hex, token, pct, chain="robinhood")        -> (ok, tx|err)
        quote_evm_token_to_native(token, amount_in_wei, chain)        -> int|None
    Tokenized stocks (real US equities, see the stock section below)
        RH_STOCKS                                    -> {ticker: (address, name)}
        is_stock(addr) / stock_by_address(addr)
        stock_price_usd(stock_addr)                  -> float USD/share
        stock_quote_buy(stock_addr, eth_amount)      -> int raw shares out
        stock_quote_sell(stock_addr, raw_amount)     -> int wei ETH out
        buy_stock(pk_hex, stock_addr, eth_amount)    -> (ok, tx|err)
        sell_stock(pk_hex, stock_addr, pct)          -> (ok, tx|err)
    Pricing / metadata
        get_native_price_usd(chain)  -> float (ETH USD)
        get_token_info(token, chain) -> dict (price, mcap, symbol via DexScreener)
    Bridge from another chain (FlashBuy; multi-chain, touches SOL too)
        flash_quote / flash_hot_addresses / flash_debit_user / flash_credit_user

HOW UNISWAP TRADING WORKS HERE (the routing model)
    Robinhood Chain runs Uniswap V2, V3 AND V4. A token can live in any of them.
      * evm_buy_tokens / evm_sell_tokens auto-detect the best venue in this order:
        V4 (via _v4_detect) -> V3 (via _v3_detect) -> V2 router fallback.
      * Detection normally reads DexScreener for the deepest pool, BUT
        DexScreener's RH indexing is unreliable, so _v3_detect also probes fee
        tiers on-chain via the QuoterV2 when DexScreener misses. Never let a sell
        silently fall through to the V2 router when the token has no V2 pool — it
        reverts and wastes gas (see evm_sell_tokens' guards).
      * V4 pools are NOT contracts. They live inside one singleton PoolManager,
        keyed by a PoolKey = (currency0, currency1, fee, tickSpacing, hooks).
        _fetch_v4_pool_key resolves a PoolKey by scanning the PoolManager's
        `Initialize` event logs (no subgraph dependency).

TOKENIZED STOCKS — THE NON-OBVIOUS PART (hours of reverse-engineering; read this)
    Robinhood issues real tokenized stocks ("Apple • Robinhood Token", etc.).
    Key facts that are easy to get wrong:
      1. They trade on Uniswap V4, and they pair against USDG (a USD stablecoin,
         RH_USDG), NOT against WETH. So buying with ETH is a 2-HOP swap:
             BUY :  WETH --(fee 500 pool)--> USDG --(fee 3000 pool)--> STOCK
             SELL:  STOCK --(fee 3000)--> USDG --(fee 500)--> WETH -> unwrap to ETH
      2. DexScreener lists FAKE WETH-paired "AAPL/TSLA/..." honeypots under the
         same tickers. They look liquid but you cannot sell (one-sided pools).
         That is why RH_STOCKS is a hand-curated, name-verified, address-pinned
         allowlist — never resolve a stock by ticker at runtime.
      3. The WETH<->USDG bridge pool exists at fee 100 (thin) and fee 500 (deep).
         Always route through fee 500. It comfortably handles up to ~0.5 ETH per
         trade; the stock/USDG pools themselves are deeper.
      4. The Universal Router V4 multi-hop calldata has a quirk verified against a
         real on-chain buy: the ExactInputParams struct is encoded as
             (currencyIn, PathKey[] path, bytes <unused>, amountIn, amountOutMin)
         — note the empty `bytes` field between path and amountIn — and the
         SETTLE action uses amount 0 (settle-all). Getting this wrong reverts with
         no error data. See _v4_encode_multihop_input; do not "simplify" it.
      Round-trips execute at ~99% (fees + slippage), proven with real funds.

GOTCHAS / OPERATIONAL NOTES
    * Solana imports come along because the bridge (FlashBuy) can bridge SOL<->EVM.
      If your new app is EVM-only, the flash_* SOL branches are the only reason
      for solana/solders; you can trim them later.
    * Percent sells use integer math on raw balances to avoid float precision
      loss above 2**53 (which would over-request and revert TRANSFER_FROM).
    * Slippage: most manual buys accept amountOutMinimum=0 (memecoin UX); stock
      buys enforce a real minimum from the quote (EVM_DEFAULT_SLIPPAGE_PCT).

CONFIG (env vars, same as the origin bot)
    ROBINHOOD_RPC, ROBINHOOD_FALLBACK_RPC, ETH_RPC, BASE_RPC, SOLANA_RPC,
    FLASH_HOT_EVM_PRIVATE_KEY, FLASH_HOT_SOL_PRIVATE_KEY, FLASH_FEE_PCT, ...

RELATIONSHIP TO main.py
    This is a point-in-time COPY. Treat robinhoodcode.py as the source of truth
    for the new app; the origin bot keeps its own copy. They will drift apart.
================================================================================
"""
from __future__ import annotations
import logging
logger = logging.getLogger("robinhoodcode")


# ── imports (from main.py) ──
import os
import re
import sys
import json
import math
import time
import logging
import asyncio
from contextlib import contextmanager
from dotenv import load_dotenv
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters,
    ContextTypes,
)
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool
import base58
import requests
from solana.rpc.api import Client
from solders.keypair import Keypair as SolKeypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer as sol_system_transfer
from solders.transaction import Transaction as SolLegacyTransaction
from solders.transaction import VersionedTransaction
from solders.commitment_config import CommitmentLevel
from solders.rpc.requests import SendVersionedTransaction
from solders.rpc.config import RpcSendTransactionConfig
from web3 import Web3
from eth_abi import encode as abi_encode
from eth_account import Account as EthAccount
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.functions.channels import JoinChannelRequest, LeaveChannelRequest
from telethon.tl.functions.messages import (
    ImportChatInviteRequest,
    CheckChatInviteRequest,
)
from telethon.errors import (
    FloodWaitError,
    ChannelPrivateError,
    UsernameNotOccupiedError,
    UsernameInvalidError,
    UserAlreadyParticipantError,
    InviteHashEmptyError,
    InviteHashInvalidError,
    InviteHashExpiredError,
)
from telethon.utils import get_peer_id
import httpx
import websockets
from websockets.exceptions import ConnectionClosed


UNISWAP_V2_ROUTER_ABI = [
    # Fee-on-transfer (tax-token) safe swap variants — used for both buys and sells
    {"inputs": [{"internalType": "uint256",   "name": "amountOutMin", "type": "uint256"},
                {"internalType": "address[]", "name": "path",         "type": "address[]"},
                {"internalType": "address",   "name": "to",           "type": "address"},
                {"internalType": "uint256",   "name": "deadline",     "type": "uint256"}],
     "name": "swapExactETHForTokensSupportingFeeOnTransferTokens",
     "outputs": [], "stateMutability": "payable", "type": "function"},
    {"inputs": [{"internalType": "uint256",   "name": "amountIn",     "type": "uint256"},
                {"internalType": "uint256",   "name": "amountOutMin", "type": "uint256"},
                {"internalType": "address[]", "name": "path",         "type": "address[]"},
                {"internalType": "address",   "name": "to",           "type": "address"},
                {"internalType": "uint256",   "name": "deadline",     "type": "uint256"}],
     "name": "swapExactTokensForETHSupportingFeeOnTransferTokens",
     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    # Quote helper — works for tax and non-tax tokens (returns the no-tax quote)
    {"inputs": [{"internalType": "uint256",   "name": "amountIn", "type": "uint256"},
                {"internalType": "address[]", "name": "path",     "type": "address[]"}],
     "name": "getAmountsOut",
     "outputs": [{"internalType": "uint256[]", "name": "amounts", "type": "uint256[]"}],
     "stateMutability": "view", "type": "function"},
]

ERC20_ABI = [
    {"inputs": [{"internalType": "address", "name": "account",  "type": "address"}],
     "name": "balanceOf",
     "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "spender", "type": "address"},
                {"internalType": "uint256", "name": "amount",  "type": "uint256"}],
     "name": "approve",
     "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
     "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "owner",   "type": "address"},
                {"internalType": "address", "name": "spender", "type": "address"}],
     "name": "allowance",
     "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "decimals",
     "outputs": [{"internalType": "uint8", "name": "", "type": "uint8"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "totalSupply",
     "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [{"internalType": "address", "name": "to",     "type": "address"},
                {"internalType": "uint256", "name": "amount", "type": "uint256"}],
     "name": "transfer",
     "outputs": [{"internalType": "bool",   "name": "",       "type": "bool"}],
     "stateMutability": "nonpayable", "type": "function"},
]

V3_SWAPROUTER02_ABI = [
    {"name": "exactInputSingle", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "params", "type": "tuple", "components": [
         {"name": "tokenIn",           "type": "address"},
         {"name": "tokenOut",          "type": "address"},
         {"name": "fee",               "type": "uint24"},
         {"name": "recipient",         "type": "address"},
         {"name": "amountIn",          "type": "uint256"},
         {"name": "amountOutMinimum",  "type": "uint256"},
         {"name": "sqrtPriceLimitX96", "type": "uint160"}]}],
     "outputs": [{"name": "amountOut", "type": "uint256"}]},
    # Unwrap WETH held by the router to native ETH → recipient (for sells).
    {"name": "unwrapWETH9", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "amountMinimum", "type": "uint256"},
                {"name": "recipient",     "type": "address"}], "outputs": []},
    {"name": "multicall", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "data", "type": "bytes[]"}],
     "outputs": [{"name": "results", "type": "bytes[]"}]},
]

V3_QUOTERV2_ABI = [{
    "name": "quoteExactInputSingle", "type": "function", "stateMutability": "nonpayable",
    "inputs": [{"name": "params", "type": "tuple", "components": [
        {"name": "tokenIn",           "type": "address"},
        {"name": "tokenOut",          "type": "address"},
        {"name": "amountIn",          "type": "uint256"},
        {"name": "fee",               "type": "uint24"},
        {"name": "sqrtPriceLimitX96", "type": "uint160"}]}],
    "outputs": [
        {"name": "amountOut",              "type": "uint256"},
        {"name": "sqrtPriceX96After",      "type": "uint160"},
        {"name": "initializedTicksCrossed", "type": "uint32"},
        {"name": "gasEstimate",            "type": "uint256"}],
}]

V3_POOL_ABI = [
    {"name": "fee", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint24"}]},
]

SOLANA_RPC        = os.environ.get("SOLANA_RPC",   "https://api.mainnet-beta.solana.com")

ETH_RPC           = os.environ.get("ETH_RPC",      "https://eth.drpc.org")

ETH_FALLBACK_RPC  = os.environ.get("ETH_FALLBACK_RPC",  "https://eth.drpc.org")

BASE_RPC          = os.environ.get("BASE_RPC",          "https://mainnet.base.org")

BASE_FALLBACK_RPC = os.environ.get("BASE_FALLBACK_RPC", "")

ROBINHOOD_RPC          = os.environ.get("ROBINHOOD_RPC",          "https://rpc.mainnet.chain.robinhood.com")

ROBINHOOD_FALLBACK_RPC = os.environ.get("ROBINHOOD_FALLBACK_RPC", "")

FLASH_HOT_SOL_PRIVATE_KEY = os.environ.get("FLASH_HOT_SOL_PRIVATE_KEY", "").strip()

FLASH_HOT_EVM_PRIVATE_KEY = os.environ.get("FLASH_HOT_EVM_PRIVATE_KEY", "").strip()

EVM_CHAINS = {
    "eth": {
        "name":         "Ethereum",
        "label":        "ETH",
        "chain_id":     1,
        "rpc":          ETH_RPC,
        "fallback":     ETH_FALLBACK_RPC,
        "router":       Web3.to_checksum_address("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"),
        "weth":         Web3.to_checksum_address("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        # ── V4 add-on ───────────────────────────────────────────────────
        # Universal Router v2 (handles V2 + V3 + V4 commands), PoolManager,
        # and Permit2 — all official Uniswap deployments on Ethereum mainnet.
        # PoolManager address has the leading-zeros pattern (storage-slot
        # gas savings on lookups); same canonical Permit2 as every chain.
        "universal_router": Web3.to_checksum_address("0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af"),
        "v4_pool_manager":  Web3.to_checksum_address("0x000000000004444c5dc75cB358380D2e3dE08A90"),
        "permit2":          Web3.to_checksum_address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
        # Uniswap V4 Quoter — eth_call simulator used for on-chain price quotes.
        "v4_quoter":        Web3.to_checksum_address("0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203"),
        "explorer_tx":  "https://etherscan.io/tx/",
        "dexscreener":  "ethereum",
    },
    "base": {
        "name":         "Base",
        "label":        "BASE",
        "chain_id":     8453,
        "rpc":          BASE_RPC,
        "fallback":     BASE_FALLBACK_RPC,
        # Uniswap V2 router on Base
        "router":       Web3.to_checksum_address("0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24"),
        "weth":         Web3.to_checksum_address("0x4200000000000000000000000000000000000006"),
        # ── V4 add-on ───────────────────────────────────────────────────
        # Universal Router v2 (handles V2 + V3 + V4 commands), PoolManager,
        # and Permit2 — all official Uniswap deployments on Base mainnet.
        "universal_router": Web3.to_checksum_address("0x6fF5693b99212Da76ad316178A184AB56D299b43"),
        "v4_pool_manager":  Web3.to_checksum_address("0x498581fF718922c3f8e6A244956aF099B2652b2b"),
        "permit2":          Web3.to_checksum_address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
        # Uniswap V4 Quoter — eth_call simulator used for on-chain price quotes.
        "v4_quoter":        Web3.to_checksum_address("0x0d5e0F971ED27FBfF6c2837bf31316121532048D"),
        "explorer_tx":  "https://basescan.org/tx/",
        "dexscreener":  "base",
    },
    "robinhood": {
        "name":         "Robinhood",
        "label":        "RH",
        "chain_id":     4663,
        "rpc":          ROBINHOOD_RPC,
        "fallback":     ROBINHOOD_FALLBACK_RPC,
        # Uniswap V2 Router02 on Robinhood Chain (factory 0x8bcE…937f, the
        # active V2 factory). Verified on-chain: WETH() == the chain's WETH.
        "router":       Web3.to_checksum_address("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba"),
        "weth":         Web3.to_checksum_address("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
        # ── Uniswap V3 ──────────────────────────────────────────────────
        # SwapRouter02 + QuoterV2, both verified on-chain to share factory
        # 0x1f7d…2EfA and return the chain's WETH. Presence of these keys
        # enables the V3 trade/quote path (see _v3_supported / _v3_detect).
        "v3_router":    Web3.to_checksum_address("0xCaf681a66D020601342297493863E78C959E5cb2"),
        "v3_quoter":    Web3.to_checksum_address("0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7"),
        # ── Uniswap V4 add-on ───────────────────────────────────────────
        # Official Uniswap V4 deployments on Robinhood Chain (4663).
        "universal_router": Web3.to_checksum_address("0x8876789976decbfcbbbe364623c63652db8c0904"),
        "v4_pool_manager":  Web3.to_checksum_address("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
        "permit2":          Web3.to_checksum_address("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
        "v4_quoter":        Web3.to_checksum_address("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
        "explorer_tx":  "https://robinhoodchain.blockscout.com/tx/",
        "dexscreener":  "robinhood",
    },
}

solana_client = Client(SOLANA_RPC)

_evm_w3:          dict[str, Web3] = {}

_evm_w3_fallback: dict[str, Web3] = {}

# Build the per-chain Web3 clients (this module-level loop lives in main.py and
# must be reproduced here so _evm_w3 is populated).
_EVM_RPC_TIMEOUT = 12
for _key, _cfg in EVM_CHAINS.items():
    _evm_w3[_key] = Web3(Web3.HTTPProvider(
        _cfg["rpc"], request_kwargs={"timeout": _EVM_RPC_TIMEOUT}))
    if _cfg["fallback"] and _cfg["fallback"] != _cfg["rpc"]:
        _evm_w3_fallback[_key] = Web3(Web3.HTTPProvider(
            _cfg["fallback"], request_kwargs={"timeout": _EVM_RPC_TIMEOUT}))


def _broadcast_evm_tx(signed_raw: bytes, chain: str) -> bytes:
    """Send via primary chain RPC; fall back to chain's fallback RPC if rejected.
    Used for swaps where the primary (e.g. MEV Blocker) provides sandwich
    protection."""
    primary  = _evm_w3[chain]
    fallback = _evm_w3_fallback.get(chain)
    try:
        return primary.eth.send_raw_transaction(signed_raw)
    except Exception as primary_e:
        if fallback is None:
            raise
        logger.warning(
            "Primary %s RPC rejected tx, retrying via fallback. Reason: %s",
            chain.upper(), primary_e)
        return fallback.eth.send_raw_transaction(signed_raw)

def _broadcast_evm_public(signed_raw: bytes, chain: str) -> bytes:
    """Send via the public-mempool RPC directly.

    For plain native transfers, MEV Blocker-style private relays add zero
    value (nothing to sandwich) but can hold the tx privately for a long
    time before it lands. Sending via the fallback (public mempool) RPC
    gets the tx propagated to every miner immediately."""
    fallback = _evm_w3_fallback.get(chain)
    if fallback is not None:
        try:
            return fallback.eth.send_raw_transaction(signed_raw)
        except Exception as e:
            logger.warning(
                "%s public RPC rejected tx, falling back to primary: %s",
                chain.upper(), e)
    return _evm_w3[chain].eth.send_raw_transaction(signed_raw)

def _wait_receipt_any_rpc(tx_hash: bytes, chain: str,
                           timeout: int) -> object:
    """Poll for a receipt across the primary AND fallback RPCs. Either RPC
    surfacing the receipt wins — useful because MEV Blocker can be slow to
    expose receipts for txs that landed via the public mempool."""
    import time as _t
    deadline = _t.time() + timeout
    clients  = [_evm_w3[chain]]
    fb       = _evm_w3_fallback.get(chain)
    if fb is not None:
        clients.append(fb)
    last_err: Exception | None = None
    while _t.time() < deadline:
        for c in clients:
            try:
                rcpt = c.eth.get_transaction_receipt(tx_hash)
                if rcpt is not None:
                    return rcpt
            except Exception as e:
                last_err = e  # most RPCs raise if not yet mined; that's fine
        _t.sleep(2)
    raise TimeoutError(
        f"No receipt for tx after {timeout}s ({last_err})")

def _tx0x(h) -> str:
    """0x-prefixed hex for a tx hash. web3 v7's HexBytes.hex() omits the 0x
    prefix; Blockscout (Robinhood's explorer) rejects a bare hash with a 422,
    so every explorer link must be 0x-prefixed. Etherscan/Basescan tolerate
    both, so this is harmless for eth/base."""
    try:
        s = h.hex()
    except AttributeError:
        s = str(h)
    return s if s.startswith("0x") else "0x" + s

def resolve_evm_chain(token: str) -> str | None:
    """Ask DexScreener which EVM chain a token lives on. Returns 'eth' / 'base' / None."""
    try:
        resp = requests.get(
            f"https://api.dexscreener.com/latest/dex/tokens/{token}", timeout=10)
        if resp.status_code != 200:
            return None
        pairs = resp.json().get("pairs") or []
        # Pick the chain with the highest liquidity that we support
        candidates = []
        for p in pairs:
            cid = p.get("chainId")
            for key, cfg in EVM_CHAINS.items():
                if cfg["dexscreener"] == cid:
                    liq = (p.get("liquidity") or {}).get("usd") or 0
                    candidates.append((key, liq))
                    break
        if not candidates:
            return None
        candidates.sort(key=lambda x: x[1], reverse=True)
        return candidates[0][0]
    except Exception as e:
        logger.error("resolve_evm_chain error: %s", e)
        return None

def humanize_sol_error(err) -> str:
    """Map any Solana / RPC / trade-API error into one short, friendly message."""
    logs: list = []
    msg = ""
    if isinstance(err, dict):
        data = err.get("data") or {}
        logs = data.get("logs") or err.get("logs") or []
        msg  = str(err.get("message", ""))
    else:
        msg = str(err)

    # Scan logs first — most specific signals live there
    for log in logs:
        l = log.lower()
        if "insufficient lamports" in l:
            return ("Your SOL balance is too low. "
                    "Add a little more SOL and try again.")
        if "exceeds desired" in l or "max_sol_cost" in l:
            return ("The price moved too much before your trade landed. "
                    "Try again or use a smaller amount.")
        if "0x1771" in l:
            return ("Price moved too much (slippage). "
                    "Try again or use a smaller amount.")

    m = msg.lower()
    if "insufficient" in m or "lamports" in m:
        return ("Your SOL balance is too low. "
                "Add a little more SOL and try again.")
    if "blockhash not found" in m:
        return "Solana is busy right now. Please try again in a few seconds."
    if "blockhash" in m:
        return "The trade took too long to send. Please try again."
    if "timed out" in m or "timeout" in m:
        return "Solana is slow right now. Please try again."
    if "node is behind" in m:
        return "Solana is catching up. Please try again in a moment."
    if "0x1" in m or "instructionerror" in m:
        return ("Trade rejected. Your wallet usually needs a little extra SOL "
                "(~0.005) to cover fees and a new token account.")
    return "The trade didn't go through. Please try again."

def humanize_eth_error(err) -> str:
    """Map any web3 / Ethereum error into one short, friendly message."""
    m = str(err).lower()
    if "insufficient funds" in m:
        return ("Your balance is too low to cover the trade plus gas. "
                "Add a little more and try again.")
    if "revert" in m:
        return _explain_revert(str(err))
    if "nonce too low" in m or "replacement transaction" in m:
        return ("You have another trade still pending. "
                "Wait a moment and try again.")
    if "gas required exceeds allowance" in m or "out of gas" in m:
        return "This token doesn't look tradeable right now."
    if "timed out" in m or "timeout" in m:
        return "The network is slow right now. Please try again."
    if "could not transact" in m or "connection" in m:
        return "Network error. Please try again."
    return "The trade didn't go through. Please try again."

def _explain_revert(raw_msg: str) -> str:
    """Decode an on-chain revert message into a friendly explanation."""
    m = raw_msg.lower()

    # DEX-level errors (slippage / liquidity / deadline)
    if "insufficient_output_amount" in m:
        return ("The token has a tax higher than 50%. "
                "This is almost certainly a scam token. Don't trade it.")
    if "insufficient_liquidity" in m or "uniswapv2: k" in m:
        return ("The token's pool is too thin for this trade size. "
                "Try selling a smaller amount.")
    if "expired" in m:
        return "The trade took too long to land. Please try again."

    # Token-side reverts
    if "transfer_from_failed" in m or "transferhelper" in m:
        return ("The token's contract blocked the trade. Common reasons:\n"
                "• It's a honeypot (you can buy but can't sell)\n"
                "• Trading hasn't been turned on by the token's creator yet\n"
                "• Your wallet is blacklisted by the token")
    if "trading" in m and ("not" in m or "disabled" in m or "paused" in m):
        return ("Trading on this token is paused. "
                "It may not have been launched yet.")
    if "max" in m and "amount" in m:
        return ("The trade is bigger than what this token allows in one go. "
                "Try selling a smaller amount.")
    if "blacklist" in m or "bot" in m:
        return "This token's contract has blacklisted your wallet."
    if "cooldown" in m:
        return "This token has a wait time between trades. Try again in a moment."

    # Generic catch-all
    return ("The trade didn't go through. Most common reasons:\n"
            "• The token is a honeypot (you can't sell it)\n"
            "• Trading is paused\n"
            "• The token has a sell tax above 50%\n"
            "• The token's pool has no liquidity")

ETH_PRIORITY_GWEI      = 5

BASE_PRIORITY_GWEI     = 0.01

EVM_RECEIPT_TIMEOUT    = 90

EVM_APPROVE_TIMEOUT    = 120

EVM_TRANSFER_TIMEOUT   = 180

def _evm_gas_price(chain: str = "eth") -> int:
    """Network gas price + chain-appropriate priority bump."""
    # Robinhood is a cheap L2 like Base — a tiny bump is plenty.
    bump_gwei = BASE_PRIORITY_GWEI if chain in ("base", "robinhood") else ETH_PRIORITY_GWEI
    bump_wei  = int(Web3.to_wei(bump_gwei, "gwei"))
    return int(_evm_w3[chain].eth.gas_price) + bump_wei

def get_evm_swap_gas_cost(chain: str = "eth") -> float:
    """Estimated native cost for a 300k-gas Uniswap swap on the given chain."""
    try:
        return float(Web3.from_wei(_evm_gas_price(chain) * 300_000, "ether"))
    except Exception:
        return 0.01 if chain == "eth" else 0.0001

def get_evm_transfer_gas_cost(chain: str = "eth",
                                from_addr: str | None = None,
                                to_addr: str | None = None) -> float:
    """Estimated native cost for a plain native transfer on `chain`.

    Default returns the EOA→EOA cost (21k gas). When `to_addr` is supplied,
    runs eth_estimateGas against current state so smart-EOA (EIP-7702) and
    contract destinations get a properly-sized reserve. Needed by the
    "send 100%" flow — under-reserving for gas there causes the actual
    broadcast to fail with insufficient-funds since evm_send (post-patch)
    builds with the real gas budget."""
    try:
        gp = _evm_gas_price(chain)
        gas = 21_000
        if to_addr:
            try:
                est_params: dict = {
                    "to":    Web3.to_checksum_address(to_addr),
                    "value": 1,  # value is a no-op for gas math on transfers
                }
                if from_addr:
                    est_params["from"] = Web3.to_checksum_address(from_addr)
                est = _evm_w3[chain].eth.estimate_gas(est_params)
                # Same 1.3x margin and 250k cap as evm_send. Reserve must
                # match what we'll actually spend, or 100% sweeps fail.
                gas = max(21_000, min(250_000, int(est * 13 // 10)))
            except Exception as e:
                # Common when destination contract reverts on ETH — fall
                # back to the larger conservative reserve (250k) so the
                # 100% calc errs on the safe side. evm_send will then
                # cleanly fail at its own estimate step with a real error.
                logger.info("get_evm_transfer_gas_cost: estimate failed (%s) "
                             "— using 250k conservative reserve", str(e)[:80])
                gas = 250_000
        return float(Web3.from_wei(gp * gas, "ether"))
    except Exception:
        return 0.001 if chain == "eth" else 0.00005

def check_evm_buy_balance(wallet: str, amount: float, chain: str = "eth") -> str | None:
    bal    = get_evm_balance(wallet, chain)
    gas    = get_evm_swap_gas_cost(chain)
    needed = amount + gas
    label  = EVM_CHAINS[chain]["label"]
    name   = EVM_CHAINS[chain]["name"]
    if bal < needed:
        short = needed - bal
        return (
            f"Your {label} balance is too low for this trade.\n\n"
            f"You have: <b>{bal:.6f} {label}</b>\n"
            f"You need: <b>~{needed:.6f} {label}</b> (the buy plus "
            f"~{gas:.5f} for network fees).\n"
            f"Short by: <b>{short:.6f} {label}</b>\n\n"
            f"Send a little more {label} to your {name} wallet and try again."
        )
    return None

def get_sol_balance(addr: str) -> float:
    try:
        return solana_client.get_balance(Pubkey.from_string(addr)).value / 1e9
    except Exception as e:
        logger.error("SOL balance error for %s: %s", addr[:8], e)
        return 0.0

def send_sol(from_pk_b58: str, to_addr: str, amount_sol: float) -> tuple[bool, str]:
    try:
        sender  = SolKeypair.from_bytes(base58.b58decode(from_pk_b58))
        ix      = sol_system_transfer(TransferParams(
            from_pubkey=sender.pubkey(),
            to_pubkey=Pubkey.from_string(to_addr),
            lamports=int(amount_sol * 1e9)))
        bh  = solana_client.get_latest_blockhash().value.blockhash
        tx  = SolLegacyTransaction.new_signed_with_payer([ix], sender.pubkey(), [sender], bh)
        res = solana_client.send_raw_transaction(bytes(tx))
        return True, str(res.value)
    except Exception as e:
        logger.error("send_sol error: %s", e)
        return False, humanize_sol_error(e)

def get_evm_balance(addr: str, chain: str = "eth") -> float:
    """Native balance (ETH on Ethereum, ETH on Base) for the given wallet."""
    try:
        wei = _evm_w3[chain].eth.get_balance(Web3.to_checksum_address(addr))
        return float(Web3.from_wei(wei, "ether"))
    except Exception as e:
        logger.error("%s balance error for %s: %s", chain.upper(), addr[:8], e)
        return 0.0

def get_evm_token_balance(wallet: str, token: str, chain: str = "eth") -> float:
    try:
        client = _evm_w3[chain]
        c   = client.eth.contract(
            address=Web3.to_checksum_address(token), abi=ERC20_ABI)
        dec = c.functions.decimals().call()
        bal = c.functions.balanceOf(Web3.to_checksum_address(wallet)).call()
        return bal / (10 ** dec)
    except Exception as e:
        logger.error("%s token balance error: %s", chain.upper(), e)
        return 0.0

def get_evm_token_balance_raw(wallet: str, token: str, chain: str = "eth") -> int:
    """Raw uint256 balance — preserves precision for percentage math on
    high-decimal tokens. Used by V4 sell path where converting through
    float would lose precision."""
    try:
        client = _evm_w3[chain]
        c   = client.eth.contract(
            address=Web3.to_checksum_address(token), abi=ERC20_ABI)
        return int(c.functions.balanceOf(Web3.to_checksum_address(wallet)).call())
    except Exception as e:
        logger.error("%s token balance raw error: %s", chain.upper(), e)
        return 0

# ############################################################################
# SENDING: native ETH transfers on any EVM chain (use chain="robinhood")
# ############################################################################
def evm_send(pk_hex: str, to_addr: str, amount: float, chain: str = "eth") -> tuple[bool, str]:
    """Native transfer (plain ETH or Base-ETH) on the given EVM chain.

    Routes through the public mempool RPC (not MEV Blocker) because there's
    nothing to sandwich on a transfer and the private relay can hold the tx
    privately past our receipt timeout.

    Gas budget: 21000 only works for EOA → EOA. If the destination is a
    contract (multisig, smart wallet, deposit address with a receive() hook,
    etc.) the contract's receive/fallback runs on top of the 21k base cost
    and reverts out-of-gas. We pre-flight via eth_estimateGas so contract
    destinations get a properly-sized budget and contracts that outright
    reject ETH are surfaced as a clean error BEFORE we broadcast."""
    try:
        client = _evm_w3[chain]
        cfg    = EVM_CHAINS[chain]
        acc    = EthAccount.from_key(pk_hex)
        dest   = Web3.to_checksum_address(to_addr)
        value_wei = Web3.to_wei(amount, "ether")

        # --- Pre-flight: estimate gas via simulation. ----------------------
        # eth_estimateGas runs the tx against current state. For an EOA dest
        # it returns 21000. For a contract dest with a working receive() it
        # returns the actual needed gas. For a contract that reverts on ETH
        # it raises — and we want to surface that BEFORE broadcasting so the
        # user keeps their funds.
        try:
            estimated = client.eth.estimate_gas({
                "from":  acc.address,
                "to":    dest,
                "value": value_wei,
            })
        except Exception as e:
            err_str = str(e)
            # Common signal: contract receive() reverts → "execution reverted"
            if "revert" in err_str.lower() or "transfer" in err_str.lower():
                explorer_addr = cfg.get("explorer_tx", "").replace("/tx/", "/address/")
                return False, (
                    "The destination address is a contract that refuses ETH "
                    "transfers. Send to a regular wallet address instead, or "
                    "ask the recipient for a deposit address that accepts "
                    f"plain {cfg['label']}. "
                    f"<a href='{explorer_addr}{dest}'>View destination</a>")
            logger.warning("evm_send (%s) estimate_gas failed: %s", chain, e)
            estimated = 21_000  # fall back to default; tx may still succeed

        # 30% safety margin (block builders enforce hard limits) capped at
        # 250k. EOA case stays at 21000 since estimate returns exactly that.
        gas_limit = max(21_000, min(250_000, int(estimated * 13 // 10)))

        # 'pending' so back-to-back transfers don't collide on nonce.
        nonce  = client.eth.get_transaction_count(acc.address, "pending")
        txn    = {
            "nonce":    nonce,
            "to":       dest,
            "value":    value_wei,
            "gas":      gas_limit,
            "gasPrice": _evm_gas_price(chain),
            "chainId":  cfg["chain_id"],
        }
        signed  = client.eth.account.sign_transaction(txn, pk_hex)
        tx_hash = _broadcast_evm_public(signed.raw_transaction, chain)
        try:
            receipt = _wait_receipt_any_rpc(
                tx_hash, chain, timeout=EVM_TRANSFER_TIMEOUT)
            if receipt.status == 1:
                return True, _tx0x(tx_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (f"The transfer was sent but the network rejected it. "
                            f"<a href='{tx_url}'>View tx</a>")
        except TimeoutError:
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (
                f"The transfer is still pending after {EVM_TRANSFER_TIMEOUT}s. "
                f"Don't try again — wait a minute and "
                f"<a href='{tx_url}'>check it here</a>.")
    except Exception as e:
        logger.error("evm_send (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

EVM_DEFAULT_SLIPPAGE_PCT = 10.0

V4_ETH_SENTINEL = "0x0000000000000000000000000000000000000000"

UR_ADDR_SENDER = Web3.to_checksum_address("0x0000000000000000000000000000000000000001")

UR_ADDR_THIS   = Web3.to_checksum_address("0x0000000000000000000000000000000000000002")

UR_CMD_V4_SWAP             = 0x10

UR_CMD_WRAP_ETH            = 0x0b

UR_CMD_UNWRAP_WETH         = 0x0c

V4_ACTION_SWAP_EXACT_IN_SINGLE = 0x06

V4_ACTION_SWAP_EXACT_IN        = 0x07

V4_ACTION_SETTLE               = 0x0b

V4_ACTION_SETTLE_ALL           = 0x0c

V4_ACTION_TAKE                 = 0x0e

V4_ACTION_TAKE_ALL             = 0x0f

_V4_INITIALIZE_SIG = (
    "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")

V4_INITIALIZE_TOPIC = "0x" + Web3.keccak(text=_V4_INITIALIZE_SIG).hex()

V4_DEPLOY_BLOCKS = {
    "base": 25_000_000,
    "eth":  21_500_000,
}

V4_DEPLOY_BLOCK_BASE = V4_DEPLOY_BLOCKS["base"]

V4_LOG_CHUNK = 9_500

UNIVERSAL_ROUTER_ABI = [{
    "name": "execute",
    "type": "function",
    "stateMutability": "payable",
    "inputs": [
        {"name": "commands", "type": "bytes"},
        {"name": "inputs",   "type": "bytes[]"},
        {"name": "deadline", "type": "uint256"},
    ],
    "outputs": [],
}]

PERMIT2_ABI = [
    {
        "name": "allowance",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "owner",   "type": "address"},
            {"name": "token",   "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [
            {"name": "amount",     "type": "uint160"},
            {"name": "expiration", "type": "uint48"},
            {"name": "nonce",      "type": "uint48"},
        ],
    },
    {
        "name": "approve",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "token",      "type": "address"},
            {"name": "spender",    "type": "address"},
            {"name": "amount",     "type": "uint160"},
            {"name": "expiration", "type": "uint48"},
        ],
        "outputs": [],
    },
]

ERC20_APPROVE_ABI = [{
    "name": "approve",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
        {"name": "spender", "type": "address"},
        {"name": "amount",  "type": "uint256"},
    ],
    "outputs": [{"name": "", "type": "bool"}],
}, {
    "name": "allowance",
    "type": "function",
    "stateMutability": "view",
    "inputs": [
        {"name": "owner",   "type": "address"},
        {"name": "spender", "type": "address"},
    ],
    "outputs": [{"name": "", "type": "uint256"}],
}]

def _v4_supported(chain: str) -> bool:
    """V4 is enabled on every EVM chain whose EVM_CHAINS entry carries
    a universal_router + v4_pool_manager + permit2 set. Currently that's
    Base and Ethereum mainnet."""
    cfg = EVM_CHAINS.get(chain, {})
    return all(k in cfg for k in
                ("universal_router", "v4_pool_manager", "permit2"))

def _dexscreener_best_pair(token: str, chain: str) -> dict | None:
    """Return the highest-liquidity DexScreener pair for the token, scoped
    to the requested chain. Used both to detect V4 and to fetch the pool_id.

    30s cached — when a channel posts a CA, every follower's pre-buy V4
    detect hits this; without caching that's N redundant API calls."""
    key = (chain, token.lower())
    hit, cached = _cache_get(_DEX_PAIR_CACHE, key)
    if hit:
        return cached
    try:
        cfg = EVM_CHAINS[chain]
        r = requests.get(
            f"https://api.dexscreener.com/latest/dex/tokens/{token}",
            timeout=10)
        if r.status_code != 200:
            return None
        pairs = (r.json() or {}).get("pairs") or []
        ds_chain = cfg.get("dexscreener", chain)
        pairs = [p for p in pairs if p.get("chainId") == ds_chain]
        if not pairs:
            _cache_put(_DEX_PAIR_CACHE, key, None)
            return None
        # Pick highest USD liquidity (most reliable pool)
        pairs.sort(key=lambda p: float((p.get("liquidity") or {}).get("usd") or 0),
                   reverse=True)
        best = pairs[0]
        _cache_put(_DEX_PAIR_CACHE, key, best)
        return best
    except Exception as e:
        logger.warning("dex best_pair (%s): %s", chain, e)
        return None

def _is_v4_pool(pair: dict | None) -> bool:
    """Identify Uniswap V4 pools from DexScreener metadata. V4 pools either
    declare dexId='uniswap_v4' / 'uni-v4' or carry a 'v4' label."""
    if not pair:
        return False
    dex = (pair.get("dexId") or "").lower()
    if "uniswap_v4" in dex or "uni-v4" in dex or dex == "uniswapv4":
        return True
    labels = pair.get("labels") or []
    return any("v4" in (l or "").lower() for l in labels)

_V4_POOLKEY_CACHE: dict[tuple[str, str], dict] = {}

def _fetch_v4_pool_key(pool_id: str, chain: str,
                        pair_created_ms: int | None = None) -> dict | None:
    """Look up a V4 pool's PoolKey by scanning PoolManager's Initialize
    event for the matching pool id. No external API dependency.

    `pair_created_ms` (from DexScreener) narrows the scan window — we
    estimate the creation block from the timestamp and search ±100k blocks.
    On a miss we fall back to a broader window.

    Returns {currency0, currency1, fee, tick_spacing, hooks} or None."""
    cfg = EVM_CHAINS.get(chain, {})
    pool_manager = cfg.get("v4_pool_manager")
    if not pool_manager:
        return None

    pid = pool_id.lower()
    if not pid.startswith("0x"):
        pid = "0x" + pid
    cache_key = (chain, pid)
    cached = _V4_POOLKEY_CACHE.get(cache_key)
    if cached:
        return cached

    # PoolId is bytes32 — pad to 32-byte topic.
    pid_topic = pid if len(pid) == 66 else ("0x" + pid[2:].rjust(64, "0"))

    client = _evm_w3[chain]
    latest = client.eth.block_number

    # Per-chain V4 deploy block — ETH block times are ~12s vs Base ~2s,
    # so the seconds→blocks math differs by chain too.
    deploy_block = V4_DEPLOY_BLOCKS.get(chain, V4_DEPLOY_BLOCK_BASE)
    seconds_per_block = 12 if chain == "eth" else 2

    # Build search windows. Tight one first using pairCreatedAt (fast hit
    # path) and a broader fallback that covers all of V4 history.
    windows: list[tuple[int, int]] = []
    if pair_created_ms:
        try:
            seconds_ago = (time.time() * 1000 - pair_created_ms) / 1000
            est_block   = max(deploy_block, latest - int(seconds_ago / seconds_per_block))
            windows.append((max(deploy_block, est_block - 100_000),
                            min(latest, est_block + 100_000)))
        except Exception:
            pass
    # Fallback: walk back from latest in 1M chunks until we hit the deploy
    # block. Cheap because indexed topic filters skip empty chunks instantly.
    windows.append((max(deploy_block, latest - 5_000_000), latest))
    windows.append((deploy_block, latest))

    for win_start, win_end in windows:
        cur = win_start
        while cur <= win_end:
            end = min(cur + V4_LOG_CHUNK, win_end)
            try:
                logs = client.eth.get_logs({
                    "fromBlock": cur,
                    "toBlock":   end,
                    "address":   pool_manager,
                    "topics":    [V4_INITIALIZE_TOPIC, pid_topic],
                })
            except Exception as e:
                logger.warning("v4 getLogs %s-%s: %s", cur, end, str(e)[:120])
                logs = []
            if logs:
                log = logs[0]
                # topics[0]=sig, [1]=poolId, [2]=currency0, [3]=currency1
                c0 = "0x" + log["topics"][2].hex()[-40:]
                c1 = "0x" + log["topics"][3].hex()[-40:]
                # data = (uint24 fee, int24 tickSpacing, address hooks,
                #         uint160 sqrtPriceX96, int24 tick)
                data = log["data"]
                if not isinstance(data, bytes):
                    data = bytes.fromhex(data[2:] if data.startswith("0x") else data)
                from eth_abi import decode as _abi_decode
                fee, ts, hooks, _sqrt, _tick = _abi_decode(
                    ["uint24", "int24", "address", "uint160", "int24"], data)
                pk = {
                    "currency0":    Web3.to_checksum_address(c0),
                    "currency1":    Web3.to_checksum_address(c1),
                    "fee":          int(fee),
                    "tick_spacing": int(ts),
                    "hooks":        Web3.to_checksum_address(hooks),
                }
                _V4_POOLKEY_CACHE[cache_key] = pk
                return pk
            cur = end + 1
    return None

def _v4_detect(token: str, chain: str) -> dict | None:
    """Return a route descriptor if `token` is best traded on Uniswap V4 on
    `chain`. Returns None when the best pair is V2 (caller falls back).

    Hooked pools are now allowed — estimate_gas catches malicious/blocking
    hooks before we broadcast. The pool's hook contract still decides the
    dynamic fee, so users may pay more on these pools (defended by our
    standard amount_out_min=0 acceptance, like tax tokens)."""
    if not _v4_supported(chain):
        return None
    pair = _dexscreener_best_pair(token, chain)
    if not _is_v4_pool(pair):
        return None
    pool_id = pair.get("pairAddress") or pair.get("poolId") or ""
    if not pool_id:
        return None
    pair_created_ms = pair.get("pairCreatedAt")
    pool_key = _fetch_v4_pool_key(pool_id, chain, pair_created_ms)
    if not pool_key:
        logger.warning("v4: PoolKey not found on-chain for %s", pool_id)
        return None
    return {"pool_id":  pool_id,
            "pool_key": pool_key,
            "pair":     pair,
            "has_hooks": pool_key["hooks"].lower() != V4_ETH_SENTINEL}

def _v4_encode_pool_key(pk: dict) -> tuple:
    """Tuple shape consumed by abi_encode for the PoolKey struct."""
    return (pk["currency0"], pk["currency1"],
            pk["fee"], pk["tick_spacing"], pk["hooks"])

def _v4_pool_uses_weth(pool_key: dict, weth: str) -> bool:
    """V4 pools can be paired with EITHER native ETH (currency=0x0) or
    WETH. We need to wrap/unwrap when the pool is WETH-paired since our
    users send/receive native ETH."""
    weth_l = weth.lower()
    return (pool_key["currency0"].lower() == weth_l
            or pool_key["currency1"].lower() == weth_l)

def _v4_encode_swap_input(pool_key: dict, zero_for_one: bool,
                           amount_in: int, amount_out_min: int,
                           currency_in: str, currency_out: str,
                           take_recipient: str | None = None,
                           payer_is_user: bool = True) -> bytes:
    """Build the V4_SWAP input bytes:
       actions = [SWAP_EXACT_IN_SINGLE,
                  SETTLE_ALL | SETTLE,
                  TAKE_ALL  | TAKE]
       params  = abi-encoded for each action.

    `take_recipient`: when None we use TAKE_ALL (V4 defaults recipient to
    UR's msgSender override = the original user). When set, we use TAKE
    with that explicit recipient — used for WETH sells where we want UR
    to keep the WETH so it can unwrap it before forwarding to the user.

    `payer_is_user`: True (default) uses SETTLE_ALL which assumes the
    user pays via Permit2. False uses SETTLE with explicit
    payerIsUser=false — for the case where UR itself holds the input
    currency (e.g. after a WRAP_ETH command put WETH in UR's balance).
    Without this, V4Router tries to permit2.transferFrom(user, WETH, …)
    and reverts with AllowanceExpired(0) because the user never set up
    a WETH Permit2 allowance (they sent ETH, not WETH)."""
    use_take = take_recipient is not None

    actions = bytes([
        V4_ACTION_SWAP_EXACT_IN_SINGLE,
        V4_ACTION_SETTLE if not payer_is_user else V4_ACTION_SETTLE_ALL,
        V4_ACTION_TAKE if use_take else V4_ACTION_TAKE_ALL,
    ])

    # Param 0 — ExactInputSingleParams
    #   (PoolKey, bool zeroForOne, uint128 amountIn,
    #    uint128 amountOutMinimum, bytes hookData)
    p0 = abi_encode(
        ["((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
        [(_v4_encode_pool_key(pool_key),
          zero_for_one,
          int(amount_in),
          int(amount_out_min),
          b"")]
    )

    # Param 1 — SETTLE_ALL(currency, maxAmount) when payer_is_user=True,
    # or SETTLE(currency, amount, bool payerIsUser=false) when UR pays.
    if payer_is_user:
        p1 = abi_encode(["address", "uint256"],
                         [Web3.to_checksum_address(currency_in),
                          int(amount_in)])
    else:
        p1 = abi_encode(["address", "uint256", "bool"],
                         [Web3.to_checksum_address(currency_in),
                          int(amount_in),
                          False])

    # Param 2 — TAKE_ALL(currency, minAmount) OR TAKE(currency, recipient, amount)
    #   For TAKE with amount=0, V4Router takes ALL credit available.
    if use_take:
        p2 = abi_encode(
            ["address", "address", "uint256"],
            [Web3.to_checksum_address(currency_out),
             Web3.to_checksum_address(take_recipient),
             0])
    else:
        p2 = abi_encode(["address", "uint256"],
                         [Web3.to_checksum_address(currency_out),
                          int(amount_out_min)])

    return abi_encode(["bytes", "bytes[]"], [actions, [p0, p1, p2]])

def _encode_wrap_eth_input(recipient: str, amount: int) -> bytes:
    """Input for UR's WRAP_ETH command. Wraps `amount` ETH from UR's
    balance (= tx.value) to WETH, sent to `recipient`."""
    return abi_encode(["address", "uint256"],
                       [Web3.to_checksum_address(recipient), int(amount)])

def _encode_unwrap_weth_input(recipient: str, amount_min: int) -> bytes:
    """Input for UR's UNWRAP_WETH command. Unwraps UR's WETH balance and
    sends native ETH to `recipient`."""
    return abi_encode(["address", "uint256"],
                       [Web3.to_checksum_address(recipient), int(amount_min)])

def _v4_ensure_permit2_approved(client, acc, token_addr: str, chain: str,
                                 amount_min: int) -> str | None:
    """Make sure (1) Permit2 is allowed to pull `token` from `acc` (ERC20
    approve to Permit2), and (2) Universal Router is allowed to pull from
    Permit2 (Permit2.approve to UR). Returns the last tx hash that was
    sent for approval bookkeeping, or None if nothing was needed."""
    cfg = EVM_CHAINS[chain]
    permit2_addr = cfg["permit2"]
    ur_addr      = cfg["universal_router"]
    token_addr   = Web3.to_checksum_address(token_addr)
    last_tx: str | None = None

    # ── (1) ERC20.allowance(owner, Permit2) ≥ amount?
    erc20 = client.eth.contract(address=token_addr, abi=ERC20_APPROVE_ABI)
    cur_erc = erc20.functions.allowance(acc.address, permit2_addr).call()
    if cur_erc < amount_min:
        nonce = client.eth.get_transaction_count(acc.address)
        fn = erc20.functions.approve(permit2_addr, 2**256 - 1)
        try:
            gas = max(60_000, int(fn.estimate_gas({"from": acc.address}) * 3 // 2))
        except Exception:
            gas = 100_000
        tx = fn.build_transaction({
            "from":     acc.address,
            "gas":      gas,
            "gasPrice": _evm_gas_price(chain),
            "nonce":    nonce,
            "chainId":  cfg["chain_id"],
        })
        signed = client.eth.account.sign_transaction(tx, acc.key)
        h = _broadcast_evm_tx(signed.raw_transaction, chain)
        client.eth.wait_for_transaction_receipt(h, timeout=120)
        last_tx = h.hex()
        logger.info("v4: ERC20.approve(Permit2) tx %s", last_tx)

    # ── (2) Permit2.allowance(owner, token, UR) ≥ amount AND not expired?
    permit2 = client.eth.contract(address=permit2_addr, abi=PERMIT2_ABI)
    cur_amt, expiration, _nonce = permit2.functions.allowance(
        acc.address, token_addr, ur_addr).call()
    now = int(client.eth.get_block("latest").timestamp)
    if cur_amt < amount_min or expiration < now + 60:
        # 30-day Permit2 grant — typical hot-wallet flow.
        new_exp = now + 30 * 24 * 3600
        nonce = client.eth.get_transaction_count(acc.address)
        fn = permit2.functions.approve(token_addr, ur_addr,
                                         2**160 - 1, new_exp)
        try:
            gas = max(80_000, int(fn.estimate_gas({"from": acc.address}) * 3 // 2))
        except Exception:
            gas = 120_000
        tx = fn.build_transaction({
            "from":     acc.address,
            "gas":      gas,
            "gasPrice": _evm_gas_price(chain),
            "nonce":    nonce,
            "chainId":  cfg["chain_id"],
        })
        signed = client.eth.account.sign_transaction(tx, acc.key)
        h = _broadcast_evm_tx(signed.raw_transaction, chain)
        client.eth.wait_for_transaction_receipt(h, timeout=120)
        last_tx = h.hex()
        logger.info("v4: Permit2.approve(UR) tx %s", last_tx)

    return last_tx

# ############################################################################
# UNISWAP V4: single-hop buy/sell via Universal Router. V4 pools live in one
# PoolManager keyed by PoolKey=(currency0,currency1,fee,tickSpacing,hooks).
# ############################################################################
def evm_v4_buy_tokens(pk_hex: str, token: str, amount_eth: float,
                       chain: str, route: dict,
                       slippage_pct: float | None = None,
                       priority_gwei: float | None = None
                       ) -> tuple[bool, str]:
    """ETH → token via Universal Router V4_SWAP. Handles both native-ETH-
    paired and WETH-paired V4 pools transparently — the user always sends
    native ETH; we wrap to WETH inside the same tx when the pool needs it."""
    try:
        client = _evm_w3[chain]
        cfg    = EVM_CHAINS[chain]
        weth   = cfg["weth"]
        acc    = EthAccount.from_key(pk_hex)
        tkn    = Web3.to_checksum_address(token)
        amount_wei = Web3.to_wei(amount_eth, "ether")
        pool_key   = route["pool_key"]
        uses_weth  = _v4_pool_uses_weth(pool_key, weth)

        # currency_in is what we PAY into the pool. currency_out is what we
        # GET. For ETH→token: pay ETH or WETH (depending on pool), get token.
        #
        # zeroForOne tells the pool which direction we're swapping. The pool
        # has (currency0, currency1) sorted by address. If we're paying
        # currency0, that's zeroForOne=true.
        currency_in  = weth if uses_weth else V4_ETH_SENTINEL
        currency_out = tkn
        zero_for_one = (pool_key["currency0"].lower() == currency_in.lower())

        # Slippage + price-impact protection (was amount_out_min=0, which let
        # sandwich bots / thin pools return dust for a full buy).
        slip = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        tokens_out = _quote_v4_native_in(token, amount_wei, chain, route)
        guard_err = _evm_buy_impact_error(chain, token, amount_wei, tokens_out)
        if guard_err:
            return False, guard_err
        if tokens_out and slip and slip > 0:
            slip_bps = max(0, min(10_000, int(slip * 100)))
            amount_out_min = (int(tokens_out) * (10_000 - slip_bps)) // 10_000
        else:
            amount_out_min = 0

        # WETH-paired pool: after WRAP_ETH, the UR contract holds the
        # WETH — V4Router must settle from UR's balance, not from the
        # user via Permit2 (which would require an allowance the user
        # has never granted).
        v4_input = _v4_encode_swap_input(
            pool_key=pool_key,
            zero_for_one=zero_for_one,
            amount_in=amount_wei,
            amount_out_min=amount_out_min,
            currency_in=currency_in,
            currency_out=currency_out,
            payer_is_user=not uses_weth)

        ur = client.eth.contract(address=cfg["universal_router"],
                                  abi=UNIVERSAL_ROUTER_ABI)
        # Build command list — WETH pools need WRAP_ETH first so UR has WETH
        # to settle. Native pools settle from tx.value directly.
        if uses_weth:
            wrap_input = _encode_wrap_eth_input(UR_ADDR_THIS, amount_wei)
            commands   = bytes([UR_CMD_WRAP_ETH, UR_CMD_V4_SWAP])
            inputs     = [wrap_input, v4_input]
        else:
            commands   = bytes([UR_CMD_V4_SWAP])
            inputs     = [v4_input]
        deadline = int(client.eth.get_block("latest").timestamp) + 600

        fn = ur.functions.execute(commands, inputs, deadline)
        try:
            est = fn.estimate_gas({"from": acc.address, "value": amount_wei})
            gas = max(300_000, min(1_500_000, int(est * 3 // 2)))
        except Exception as e:
            gas = 900_000
            logger.warning("v4 buy (%s) gas estimate failed (%s), using %s",
                            chain, e, gas)

        tx_base = {
            "from":     acc.address,
            "value":    amount_wei,
            "gas":      gas,
            "nonce":    client.eth.get_transaction_count(acc.address),
            "chainId":  cfg["chain_id"],
        }
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        tx = fn.build_transaction(tx_base)
        signed = client.eth.account.sign_transaction(tx, pk_hex)
        tx_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        try:
            receipt = client.eth.wait_for_transaction_receipt(
                tx_hash, timeout=EVM_RECEIPT_TIMEOUT)
            if receipt.status == 1:
                return True, _tx0x(tx_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (f"The V4 buy reverted. "
                            f"<a href='{tx_url}'>View tx</a>")
        except Exception:
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (
                f"V4 buy still pending after {EVM_RECEIPT_TIMEOUT}s. "
                f"<a href='{tx_url}'>Check it</a>")
    except Exception as e:
        logger.error("v4 buy (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

_V4_QUOTER_ABI = [{
    "name": "quoteExactInputSingle",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [{
        "name": "params",
        "type": "tuple",
        "components": [
            {"name": "poolKey", "type": "tuple", "components": [
                {"name": "currency0",   "type": "address"},
                {"name": "currency1",   "type": "address"},
                {"name": "fee",         "type": "uint24"},
                {"name": "tickSpacing", "type": "int24"},
                {"name": "hooks",       "type": "address"},
            ]},
            {"name": "zeroForOne",   "type": "bool"},
            {"name": "exactAmount",  "type": "uint128"},
            {"name": "hookData",     "type": "bytes"},
        ],
    }],
    "outputs": [
        {"name": "amountOut",   "type": "uint256"},
        {"name": "gasEstimate", "type": "uint256"},
    ],
}]

def _quote_v4_exact_in(token: str, amount_in_wei: int, chain: str,
                        route: dict) -> int | None:
    """Simulate `amount_in_wei` token → WETH/native through V4 Quoter.
    Returns the expected output in wei, or None if the call reverts."""
    try:
        cfg = EVM_CHAINS.get(chain) or {}
        quoter_addr = cfg.get("v4_quoter")
        if not quoter_addr:
            return None
        client = _evm_w3[chain]
        pool_key = route["pool_key"]
        token_l = Web3.to_checksum_address(token).lower()
        zero_for_one = (pool_key["currency0"].lower() == token_l)
        params = (
            (pool_key["currency0"], pool_key["currency1"],
             pool_key["fee"], pool_key["tick_spacing"], pool_key["hooks"]),
            zero_for_one,
            int(amount_in_wei),
            b"",
        )
        quoter = client.eth.contract(address=quoter_addr, abi=_V4_QUOTER_ABI)
        amount_out, _gas = quoter.functions.quoteExactInputSingle(params).call()
        return int(amount_out)
    except Exception as e:
        logger.info("v4 quoter call failed for %s on %s: %s",
                    token[:10], chain, str(e)[:120])
        return None


EVM_MAX_BUY_IMPACT_PCT = float(os.environ.get("EVM_MAX_BUY_IMPACT_PCT", "60") or 60)


def _quote_v4_native_in(token: str, amount_in_wei: int, chain: str,
                         route: dict) -> int | None:
    """Simulate native/WETH → token through the V4 Quoter (the BUY direction)."""
    try:
        cfg = EVM_CHAINS.get(chain) or {}
        quoter_addr = cfg.get("v4_quoter")
        if not quoter_addr:
            return None
        client = _evm_w3[chain]
        pool_key = route["pool_key"]
        weth = cfg["weth"]
        currency_in = weth if _v4_pool_uses_weth(pool_key, weth) else V4_ETH_SENTINEL
        zero_for_one = (pool_key["currency0"].lower() == currency_in.lower())
        params = (
            (pool_key["currency0"], pool_key["currency1"],
             pool_key["fee"], pool_key["tick_spacing"], pool_key["hooks"]),
            zero_for_one, int(amount_in_wei), b"")
        quoter = client.eth.contract(address=quoter_addr, abi=_V4_QUOTER_ABI)
        out, _gas = quoter.functions.quoteExactInputSingle(params).call()
        return int(out)
    except Exception as e:
        logger.info("v4 native-in quote failed for %s on %s: %s",
                    token[:10], chain, str(e)[:120])
        return None


def _evm_buy_impact_error(chain: str, token: str, amount_wei: int,
                           tokens_out: int | None) -> str | None:
    """Block a buy that would round-trip back to < (100-EVM_MAX_BUY_IMPACT_PCT)%
    of what was paid (thin/wrong pool, honeypot, extreme tax). Returns an error
    string to abort, or None to proceed."""
    try:
        if not tokens_out or tokens_out <= 0:
            return ("Couldn't price this buy — no tradeable liquidity found. "
                    "Trade blocked to protect your funds.")
        back = quote_evm_token_to_native(token, int(tokens_out), chain)
        if back is None or amount_wei <= 0:
            return None
        recover_pct = back / amount_wei * 100.0
        if recover_pct < (100.0 - EVM_MAX_BUY_IMPACT_PCT):
            return (f"🛑 Trade blocked — price impact too high. You'd get tokens "
                    f"worth only ~{recover_pct:.1f}% of your "
                    f"{Web3.from_wei(amount_wei,'ether')} ETH (pool too thin or "
                    f"token restricted). Try a smaller size or a different token.")
        return None
    except Exception as e:
        logger.warning("buy impact guard error for %s: %s", token[:10], e)
        return None


def quote_evm_token_to_native(token: str, amount_in_wei: int,
                                chain: str) -> int | None:
    """Best on-chain quote of `amount_in_wei` token → native (ETH wei).
    Tries V4 Quoter for V4 pools, falls back to V2 getAmountsOut, then
    returns None so the caller can fall back to DexScreener pricing."""
    if amount_in_wei <= 0:
        return None
    # V4 first when supported and the deepest pair is V4.
    if _v4_supported(chain):
        route = _v4_detect(token, chain)
        if route and route.get("pool_key"):
            out = _quote_v4_exact_in(token, amount_in_wei, chain, route)
            if out and out > 0:
                return out
    # V3 next when supported and the deepest pair is V3.
    if _v3_supported(chain):
        v3 = _v3_detect(token, chain)
        if v3:
            out = _quote_v3_exact_in(token, amount_in_wei, chain, v3)
            if out and out > 0:
                return out
    # V2 fallback.
    try:
        client = _evm_w3[chain]
        cfg = EVM_CHAINS[chain]
        router = client.eth.contract(address=cfg["router"], abi=UNISWAP_V2_ROUTER_ABI)
        path = [Web3.to_checksum_address(token), cfg["weth"]]
        amounts = router.functions.getAmountsOut(int(amount_in_wei), path).call()
        return int(amounts[-1])
    except Exception as e:
        logger.info("v2 getAmountsOut failed for %s on %s: %s",
                    token[:10], chain, str(e)[:120])
        return None

def evm_v4_sell_tokens(pk_hex: str, token: str, pct: int,
                        chain: str, route: dict,
                        slippage_pct: float | None = None,
                        priority_gwei: float | None = None
                        ) -> tuple[bool, str]:
    """Token → ETH via Universal Router V4_SWAP. For WETH-paired pools we
    keep the WETH inside UR and unwrap it to native ETH before forwarding
    to the user — fully atomic in a single tx."""
    try:
        client = _evm_w3[chain]
        cfg    = EVM_CHAINS[chain]
        weth   = cfg["weth"]
        acc    = EthAccount.from_key(pk_hex)
        tkn    = Web3.to_checksum_address(token)
        pool_key  = route["pool_key"]
        uses_weth = _v4_pool_uses_weth(pool_key, weth)

        # Fetch full balance (raw uint). Integer math avoids precision loss.
        bal = get_evm_token_balance_raw(acc.address, tkn, chain)
        if bal <= 0:
            return False, "No token balance to sell."
        amount_in = bal if pct >= 100 else (bal * int(pct)) // 100
        if amount_in <= 0:
            return False, "Sell amount rounded to zero — try a larger %."

        _v4_ensure_permit2_approved(client, acc, tkn, chain, amount_in)

        # Selling token → either native ETH directly (native-ETH pool) or
        # WETH (WETH-paired pool, we unwrap after).
        currency_in  = tkn
        currency_out = weth if uses_weth else V4_ETH_SENTINEL
        # zeroForOne = paying currency0. We're paying the token side.
        zero_for_one = (pool_key["currency0"].lower() == tkn.lower())

        # For WETH pools we need UR to KEEP the WETH so it can unwrap it.
        # Pass take_recipient=ADDRESS_THIS — TAKE sends to UR explicitly
        # instead of TAKE_ALL which would send to the user as WETH.
        take_recipient = UR_ADDR_THIS if uses_weth else None

        # Slippage floor (was 0) so a sandwich can't dump your tokens for dust.
        slip = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        _exp = _quote_v4_exact_in(token, amount_in, chain, route)
        if _exp and slip and slip > 0:
            _bps = max(0, min(10_000, int(slip * 100)))
            amount_out_min = (int(_exp) * (10_000 - _bps)) // 10_000
        else:
            amount_out_min = 0

        v4_input = _v4_encode_swap_input(
            pool_key=pool_key,
            zero_for_one=zero_for_one,
            amount_in=amount_in,
            amount_out_min=amount_out_min,
            currency_in=currency_in,
            currency_out=currency_out,
            take_recipient=take_recipient)

        ur = client.eth.contract(address=cfg["universal_router"],
                                  abi=UNIVERSAL_ROUTER_ABI)
        if uses_weth:
            unwrap_input = _encode_unwrap_weth_input(UR_ADDR_SENDER, 0)
            commands     = bytes([UR_CMD_V4_SWAP, UR_CMD_UNWRAP_WETH])
            inputs       = [v4_input, unwrap_input]
        else:
            commands     = bytes([UR_CMD_V4_SWAP])
            inputs       = [v4_input]
        deadline = int(client.eth.get_block("latest").timestamp) + 600

        fn = ur.functions.execute(commands, inputs, deadline)
        try:
            est = fn.estimate_gas({"from": acc.address})
            gas = max(350_000, min(1_500_000, int(est * 3 // 2)))
        except Exception as e:
            gas = 900_000
            logger.warning("v4 sell (%s) gas estimate failed (%s), using %s",
                            chain, e, gas)

        tx_base = {
            "from":     acc.address,
            "gas":      gas,
            "nonce":    client.eth.get_transaction_count(acc.address),
            "chainId":  cfg["chain_id"],
        }
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        tx = fn.build_transaction(tx_base)
        signed = client.eth.account.sign_transaction(tx, pk_hex)
        tx_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        try:
            receipt = client.eth.wait_for_transaction_receipt(
                tx_hash, timeout=EVM_RECEIPT_TIMEOUT)
            if receipt.status == 1:
                return True, _tx0x(tx_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (f"The V4 sell reverted. "
                            f"<a href='{tx_url}'>View tx</a>")
        except Exception:
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (
                f"V4 sell still pending after {EVM_RECEIPT_TIMEOUT}s. "
                f"<a href='{tx_url}'>Check it</a>")
    except Exception as e:
        logger.error("v4 sell (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

def _evm_tx_fees(chain: str, priority_gwei: float | None) -> dict:
    """Return the right fee fields for the tx dict based on whether the
    caller specified a custom priority gwei.

    No override → legacy gasPrice (matches old behavior).
    With override → EIP-1559 type-2 (maxFeePerGas + maxPriorityFeePerGas)."""
    if priority_gwei is None or priority_gwei <= 0:
        return {"gasPrice": _evm_gas_price(chain)}
    client = _evm_w3[chain]
    try:
        base_fee = client.eth.get_block("latest").get("baseFeePerGas", 0) or 0
    except Exception:
        base_fee = 0
    priority_wei = int(priority_gwei * 1e9)
    max_fee = int(base_fee * 2) + priority_wei
    return {
        "maxPriorityFeePerGas": priority_wei,
        "maxFeePerGas":         max_fee,
        "type":                 2,
    }

_V3_ADDRESS_THIS = "0x0000000000000000000000000000000000000002"

_V3_FEE_TIERS = (500, 3000, 10000, 100)

def _v3_supported(chain: str) -> bool:
    """V3 enabled on any EVM chain whose EVM_CHAINS entry carries v3_router + v3_quoter."""
    cfg = EVM_CHAINS.get(chain, {})
    return "v3_router" in cfg and "v3_quoter" in cfg

def _is_v3_pool(pair: dict | None) -> bool:
    """Identify Uniswap V3 pools from DexScreener metadata (labels/dexId).
    Explicitly excludes V4 (handled by its own path)."""
    if not pair:
        return False
    labels = [(l or "").lower() for l in (pair.get("labels") or [])]
    if any("v4" in l for l in labels):
        return False
    dex = (pair.get("dexId") or "").lower()
    if "uniswap_v3" in dex or "uni-v3" in dex or dex == "uniswapv3":
        return True
    return any("v3" in l for l in labels)

def _v3_probe_fee(client, quoter_addr: str, token_in: str, token_out: str,
                   amount_in: int) -> int | None:
    """Pick the fee tier with the deepest liquidity by quoting a small
    token_in → token_out across the common tiers and taking the best out."""
    quoter = client.eth.contract(address=quoter_addr, abi=V3_QUOTERV2_ABI)
    best_fee, best_out = None, 0
    for fee in _V3_FEE_TIERS:
        try:
            out = quoter.functions.quoteExactInputSingle(
                (token_in, token_out, int(amount_in), int(fee), 0)).call()[0]
            if out and out > best_out:
                best_fee, best_out = int(fee), int(out)
        except Exception:
            continue
    return best_fee

# ############################################################################
# UNISWAP V3: detect/quote/buy/sell via SwapRouter02 + QuoterV2. Detection
# falls back to on-chain fee-tier probing when DexScreener is unreliable.
# ############################################################################
def _v3_detect(token: str, chain: str) -> dict | None:
    """Resolve a Uniswap V3 route for `token` → {fee, pair, pool_addr} or None.

    Primary path uses the deepest DexScreener pair. But DexScreener's RH
    indexing is flaky and its API can time out — and when it does we must NOT
    silently fall through to the V2 router: most RH tokens have no V2 pool, so
    a V2 sell reverts and strands the user (this is exactly what reverted the
    THROBBIN sell). So when DexScreener doesn't identify a V3 pool we PROBE the
    fee tiers on-chain via QuoterV2; if any tier quotes, a tradable V3 pool
    exists and we route to it regardless of what DexScreener returned."""
    if not _v3_supported(chain):
        return None
    cfg    = EVM_CHAINS[chain]
    client = _evm_w3[chain]
    tkn    = Web3.to_checksum_address(token)
    pair   = _dexscreener_best_pair(token, chain)

    # Primary: DexScreener identifies a V3 pool → read its exact fee tier.
    if _is_v3_pool(pair):
        fee = None
        pool_addr = (pair or {}).get("pairAddress")
        if pool_addr:
            try:
                fee = client.eth.contract(
                    address=Web3.to_checksum_address(pool_addr),
                    abi=V3_POOL_ABI).functions.fee().call()
            except Exception:
                fee = None
        if not fee:
            try:
                fee = _v3_probe_fee(client, cfg["v3_quoter"], cfg["weth"], tkn,
                                     Web3.to_wei(0.001, "ether"))
            except Exception:
                fee = None
        if fee:
            return {"fee": int(fee), "pair": pair, "pool_addr": pool_addr}

    # Fallback: DexScreener miss (API down / unindexed / mislabeled). Don't
    # trust it — probe on-chain. Skip only when the best pair is clearly V4
    # (that path is tried before V3 in dispatch and owns the routing).
    if not _is_v4_pool(pair):
        try:
            fee = _v3_probe_fee(client, cfg["v3_quoter"], cfg["weth"], tkn,
                                 Web3.to_wei(0.001, "ether"))
            if fee:
                logger.info("v3 detect: on-chain probe found fee %s for %s "
                            "(DexScreener miss)", fee, token[:10])
                return {"fee": int(fee), "pair": pair, "pool_addr": None}
        except Exception as e:
            logger.info("v3 on-chain probe failed for %s: %s", token[:10], str(e)[:80])
    return None

def _quote_v3_exact_in(token: str, amount_in_wei: int, chain: str,
                        route: dict) -> int | None:
    """Simulate `amount_in_wei` token → WETH through QuoterV2. Returns wei out or None."""
    try:
        cfg = EVM_CHAINS.get(chain) or {}
        quoter_addr = cfg.get("v3_quoter")
        if not quoter_addr:
            return None
        client = _evm_w3[chain]
        quoter = client.eth.contract(address=quoter_addr, abi=V3_QUOTERV2_ABI)
        out = quoter.functions.quoteExactInputSingle(
            (Web3.to_checksum_address(token), cfg["weth"],
             int(amount_in_wei), int(route["fee"]), 0)).call()[0]
        return int(out)
    except Exception as e:
        logger.info("v3 quoter call failed for %s on %s: %s",
                    token[:10], chain, str(e)[:120])
        return None

def _v3_amount_out_min(client, quoter_addr: str, token_in: str, token_out: str,
                        fee: int, amount_in: int, slippage_pct: float | None) -> int:
    """QuoterV2 expected out with slippage applied. None/0 slippage → 0."""
    if not slippage_pct or slippage_pct <= 0:
        return 0
    try:
        quoter = client.eth.contract(address=quoter_addr, abi=V3_QUOTERV2_ABI)
        expected = int(quoter.functions.quoteExactInputSingle(
            (token_in, token_out, int(amount_in), int(fee), 0)).call()[0])
        slip_bps = max(0, min(10_000, int(slippage_pct * 100)))
        return (expected * (10_000 - slip_bps)) // 10_000
    except Exception as e:
        logger.warning("v3 quote for slippage failed (%s) — using 0", e)
        return 0

def evm_v3_buy_tokens(pk_hex: str, token: str, amount_eth: float, chain: str,
                       route: dict, slippage_pct: float | None = None,
                       priority_gwei: float | None = None) -> tuple[bool, str]:
    """ETH → token via SwapRouter02.exactInputSingle (router wraps msg.value)."""
    try:
        client = _evm_w3[chain]
        cfg    = EVM_CHAINS[chain]
        acc    = EthAccount.from_key(pk_hex)
        tkn    = Web3.to_checksum_address(token)
        router = client.eth.contract(address=cfg["v3_router"], abi=V3_SWAPROUTER02_ABI)
        amt    = Web3.to_wei(amount_eth, "ether")
        fee    = int(route["fee"])
        slip   = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        try:
            _q = client.eth.contract(address=cfg["v3_quoter"], abi=V3_QUOTERV2_ABI)
            tokens_out = int(_q.functions.quoteExactInputSingle(
                (cfg["weth"], tkn, int(amt), fee, 0)).call()[0])
        except Exception:
            tokens_out = None
        guard_err = _evm_buy_impact_error(chain, token, amt, tokens_out)
        if guard_err:
            return False, guard_err
        if tokens_out and slip and slip > 0:
            _bps = max(0, min(10_000, int(slip * 100)))
            amount_out_min = (int(tokens_out) * (10_000 - _bps)) // 10_000
        else:
            amount_out_min = 0
        swap_fn = router.functions.exactInputSingle(
            (cfg["weth"], tkn, fee, acc.address, amt, amount_out_min, 0))
        try:
            est = swap_fn.estimate_gas({"from": acc.address, "value": amt})
            gas_limit = max(200_000, min(1_000_000, int(est * 3 // 2)))
        except Exception as e:
            gas_limit = 700_000
            logger.warning("evm_v3_buy (%s): gas estimate failed (%s), using %s",
                            chain, e, gas_limit)
        tx_base = {"from": acc.address, "value": amt, "gas": gas_limit,
                   "nonce": client.eth.get_transaction_count(acc.address),
                   "chainId": cfg["chain_id"]}
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        txn = swap_fn.build_transaction(tx_base)
        signed  = client.eth.account.sign_transaction(txn, pk_hex)
        tx_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        try:
            receipt = client.eth.wait_for_transaction_receipt(
                tx_hash, timeout=EVM_RECEIPT_TIMEOUT)
            if receipt.status == 1:
                return True, _tx0x(tx_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, f"The buy didn't go through. <a href='{tx_url}'>View tx</a>"
        except Exception:
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (f"The buy is still pending after {EVM_RECEIPT_TIMEOUT}s. "
                            f"Don't try again — wait a minute and "
                            f"<a href='{tx_url}'>check it here</a>.")
    except Exception as e:
        logger.error("evm_v3_buy (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

def evm_v3_sell_tokens(pk_hex: str, token: str, pct: int, chain: str,
                        route: dict, slippage_pct: float | None = None,
                        priority_gwei: float | None = None) -> tuple[bool, str]:
    """token → ETH via SwapRouter02: exactInputSingle(recipient=router) +
    unwrapWETH9(→user) in one multicall. Needs a plain ERC20 approve first."""
    try:
        client = _evm_w3[chain]
        cfg    = EVM_CHAINS[chain]
        acc    = EthAccount.from_key(pk_hex)
        tkn    = Web3.to_checksum_address(token)
        tc     = client.eth.contract(address=tkn, abi=ERC20_ABI)
        router_addr = cfg["v3_router"]
        router = client.eth.contract(address=router_addr, abi=V3_SWAPROUTER02_ABI)
        fee    = int(route["fee"])

        bal = tc.functions.balanceOf(acc.address).call()
        amt = (bal * pct) // 100
        if pct >= 100:
            amt = bal
        if amt == 0:
            return False, "No tokens to sell"

        nonce = client.eth.get_transaction_count(acc.address)
        gp    = _evm_gas_price(chain)
        # Approve SwapRouter02 (plain ERC20 approve — no Permit2 for direct V3).
        allowance = tc.functions.allowance(acc.address, router_addr).call()
        if allowance < amt:
            ap = tc.functions.approve(router_addr, 2**256 - 1).build_transaction(
                {"from": acc.address, "gas": 100_000, "gasPrice": gp,
                 "nonce": nonce, "chainId": cfg["chain_id"]})
            sa = client.eth.account.sign_transaction(ap, pk_hex)
            ap_hash = _broadcast_evm_tx(sa.raw_transaction, chain)
            try:
                rcpt = client.eth.wait_for_transaction_receipt(
                    ap_hash, timeout=EVM_APPROVE_TIMEOUT)
            except Exception:
                ap_url = f"{cfg['explorer_tx']}{_tx0x(ap_hash)}"
                return False, (f"Approving the token for selling is taking longer "
                                f"than {EVM_APPROVE_TIMEOUT}s. Wait a minute, then try "
                                f"again. <a href='{ap_url}'>View approval</a>")
            if rcpt.status != 1:
                ap_url = f"{cfg['explorer_tx']}{_tx0x(ap_hash)}"
                return False, (f"Approving the token for selling didn't go through. "
                                f"<a href='{ap_url}'>View tx</a>")
            nonce += 1

        slip = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        amount_out_min = _v3_amount_out_min(
            client, cfg["v3_quoter"], tkn, cfg["weth"], fee, amt, slip)
        # recipient = ADDRESS_THIS (address(2)) → SwapRouter02 keeps the WETH
        # in the router; unwrapWETH9 then forwards native ETH to the user.
        swap_call   = router.functions.exactInputSingle(
            (tkn, cfg["weth"], fee, _V3_ADDRESS_THIS, amt, amount_out_min, 0))
        unwrap_call = router.functions.unwrapWETH9(amount_out_min, acc.address)
        calls = [Web3.to_bytes(hexstr=swap_call._encode_transaction_data()),
                 Web3.to_bytes(hexstr=unwrap_call._encode_transaction_data())]
        multicall_fn = router.functions.multicall(calls)
        try:
            est = multicall_fn.estimate_gas({"from": acc.address})
            gas_limit = max(200_000, min(1_000_000, int(est * 3 // 2)))
        except Exception as e:
            gas_limit = 700_000
            logger.warning("evm_v3_sell (%s): gas estimate failed (%s), using %s",
                            chain, e, gas_limit)
        tx_base = {"from": acc.address, "gas": gas_limit, "nonce": nonce,
                   "chainId": cfg["chain_id"]}
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        txn = multicall_fn.build_transaction(tx_base)
        signed    = client.eth.account.sign_transaction(txn, pk_hex)
        swap_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        try:
            receipt = client.eth.wait_for_transaction_receipt(
                swap_hash, timeout=EVM_RECEIPT_TIMEOUT)
            if receipt.status == 1:
                return True, _tx0x(swap_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(swap_hash)}"
            return False, f"The sell didn't go through. <a href='{tx_url}'>View tx</a>"
        except Exception:
            tx_url = f"{cfg['explorer_tx']}{_tx0x(swap_hash)}"
            return False, (f"The sell is still pending after {EVM_RECEIPT_TIMEOUT}s. "
                            f"Don't try again — wait a minute and "
                            f"<a href='{tx_url}'>check it here</a>.")
    except Exception as e:
        logger.error("evm_v3_sell (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

def _v2_amount_out_min(client, router_addr: str, amount_in: int,
                        path: list, slippage_pct: float | None) -> int:
    """Quote the V2 router for amountOut, apply slippage. None / 0 = no
    protection (returns 0). Caller passes amount_in in raw wei (or token
    decimals for ERC20→ERC20)."""
    if not slippage_pct or slippage_pct <= 0:
        return 0
    try:
        r = client.eth.contract(address=router_addr, abi=UNISWAP_V2_ROUTER_ABI)
        amounts = r.functions.getAmountsOut(amount_in, path).call()
        expected = int(amounts[-1])
        # amountOutMin = expected * (1 - slippage/100), integer math.
        slip_bps = max(0, min(10_000, int(slippage_pct * 100)))
        return (expected * (10_000 - slip_bps)) // 10_000
    except Exception as e:
        logger.warning("getAmountsOut for slippage failed (%s) — using 0", e)
        return 0

# ############################################################################
# TOKENIZED STOCKS: real US equities on V4, paired against USDG (not WETH).
# Buying with ETH is a 2-hop swap WETH->USDG->STOCK. See the module header for
# the full explanation and the calldata quirk. RH_STOCKS is address-pinned.
# ############################################################################
RH_USDG = Web3.to_checksum_address("0x5fc5360d0400a0fd4f2af552add042d716f1d168")

RH_BRIDGE_FEE, RH_BRIDGE_TS = 500, 10

RH_STOCK_FEE, RH_STOCK_TS = 3000, 60

RH_STOCKS: dict[str, tuple[str, str]] = {
    "AAPL":  ("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", "Apple"),
    "TSLA":  ("0x322F0929c4625eD5bAd873c95208D54E1c003b2d", "Tesla"),
    "NVDA":  ("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "NVIDIA"),
    "MSFT":  ("0xe93237C50D904957Cf27E7B1133b510C669c2e74", "Microsoft"),
    "GOOGL": ("0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", "Alphabet"),
    "AMZN":  ("0x12f190a9F9d7D37a250758b26824B97CE941bF54", "Amazon"),
    "META":  ("0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", "Meta"),
    "SPY":   ("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", "S&P 500 ETF"),
    # NFLX / AMD / QQQ exist but their USDG pools are too thin to trade today;
    # add them back once liquidity shows up.
}

_STOCK_BY_ADDR = {a.lower(): (t, n) for t, (a, n) in RH_STOCKS.items()}

def stock_by_address(addr: str) -> tuple[str, str] | None:
    return _STOCK_BY_ADDR.get((addr or "").lower())

def is_stock(addr: str) -> bool:
    return (addr or "").lower() in _STOCK_BY_ADDR

def _v4_encode_multihop_input(currency_in: str, path: list[tuple],
                               amount_in: int, amount_out_min: int,
                               currency_out: str, take_recipient: str,
                               payer_is_user: bool) -> bytes:
    """Build V4_SWAP input for a multi-hop exact-in swap. Mirrors the exact
    action set of a real on-chain Robinhood-stock buy:
       actions = [SWAP_EXACT_IN, SETTLE(_ALL), TAKE]
    The output is TAKEn to `take_recipient` (the user for buys, the router
    itself for sells so it can UNWRAP_WETH). amount=0 in TAKE means "all
    credit"; slippage is enforced by amountOutMinimum inside the swap params.
    path entries are (intermediateCurrency, fee, tickSpacing, hooks, hookData)."""
    actions = bytes([
        V4_ACTION_SWAP_EXACT_IN,
        V4_ACTION_SETTLE if not payer_is_user else V4_ACTION_SETTLE_ALL,
        V4_ACTION_TAKE,
    ])
    # ExactInputParams on-chain layout, verified byte-identical to a real buy:
    # (currencyIn, PathKey[] path, bytes <unused>, amountIn, amountOutMinimum)
    p0 = abi_encode(
        ["(address,(address,uint24,int24,address,bytes)[],bytes,uint128,uint128)"],
        [(Web3.to_checksum_address(currency_in),
          [(Web3.to_checksum_address(c), int(f), int(t),
            Web3.to_checksum_address(h), hd) for (c, f, t, h, hd) in path],
          b"", int(amount_in), int(amount_out_min))])
    if payer_is_user:
        # SETTLE_ALL(currency, maxAmount)
        p1 = abi_encode(["address", "uint256"],
                        [Web3.to_checksum_address(currency_in), int(amount_in)])
    else:
        # SETTLE(currency, amount=0 -> settle full open delta, payerIsUser=false)
        p1 = abi_encode(["address", "uint256", "bool"],
                        [Web3.to_checksum_address(currency_in), 0, False])
    # TAKE(currency, recipient, amount=0 -> take all resulting credit)
    p2 = abi_encode(["address", "address", "uint256"],
                    [Web3.to_checksum_address(currency_out),
                     Web3.to_checksum_address(take_recipient), 0])
    return abi_encode(["bytes", "bytes[]"], [actions, [p0, p1, p2]])

_V4_QUOTER_MULTI_ABI = [{
    "name": "quoteExactInput", "type": "function", "stateMutability": "nonpayable",
    "inputs": [{"name": "params", "type": "tuple", "components": [
        {"name": "exactCurrency", "type": "address"},
        {"name": "path", "type": "tuple[]", "components": [
            {"name": "intermediateCurrency", "type": "address"},
            {"name": "fee", "type": "uint24"},
            {"name": "tickSpacing", "type": "int24"},
            {"name": "hooks", "type": "address"},
            {"name": "hookData", "type": "bytes"}]},
        {"name": "exactAmount", "type": "uint128"}]}],
    "outputs": [{"name": "amountOut", "type": "uint256"},
                {"name": "gasEstimate", "type": "uint256"}],
}]

_ZERO_ADDR = "0x0000000000000000000000000000000000000000"

def _stock_quoter():
    cfg = EVM_CHAINS["robinhood"]
    return _evm_w3["robinhood"].eth.contract(
        address=cfg["v4_quoter"], abi=_V4_QUOTER_MULTI_ABI)

def stock_quote_buy(stock: str, eth_amount: float) -> int | None:
    """Quote ETH -> USDG -> STOCK. Returns raw stock out (18 dec) or None."""
    try:
        weth = EVM_CHAINS["robinhood"]["weth"]
        amt = Web3.to_wei(eth_amount, "ether")
        path = [(RH_USDG, RH_BRIDGE_FEE, RH_BRIDGE_TS, _ZERO_ADDR, b""),
                (Web3.to_checksum_address(stock), RH_STOCK_FEE, RH_STOCK_TS, _ZERO_ADDR, b"")]
        out, _ = _stock_quoter().functions.quoteExactInput(
            (Web3.to_checksum_address(weth), path, int(amt))).call()
        return int(out)
    except Exception as e:
        logger.info("stock buy quote failed %s: %s", stock[:10], str(e)[:80])
        return None

def stock_quote_sell(stock: str, raw_amount: int) -> int | None:
    """Quote STOCK -> USDG -> ETH. Returns wei out or None."""
    try:
        weth = EVM_CHAINS["robinhood"]["weth"]
        path = [(RH_USDG, RH_STOCK_FEE, RH_STOCK_TS, _ZERO_ADDR, b""),
                (Web3.to_checksum_address(weth), RH_BRIDGE_FEE, RH_BRIDGE_TS, _ZERO_ADDR, b"")]
        out, _ = _stock_quoter().functions.quoteExactInput(
            (Web3.to_checksum_address(stock), path, int(raw_amount))).call()
        return int(out)
    except Exception as e:
        logger.info("stock sell quote failed %s: %s", stock[:10], str(e)[:80])
        return None

def stock_price_usd(stock: str) -> float | None:
    """Live share price in USD, derived from a 1-share sell quote through USDG
    (USDG ~= $1, so the USDG leg is the dollar value)."""
    try:
        # quote selling 0.01 shares -> USDG value, scale up. Small size = tight.
        usdg_quoter = _stock_usdg_quoter()
        out = usdg_quoter(stock, int(0.01 * 1e18))  # stock -> USDG (leg 2 only)
        return (out / 1e6) / 0.01 if out else None
    except Exception:
        return None

def _stock_usdg_quoter():
    """Return fn(stock, raw)->usdg_raw for the single STOCK/USDG hop (pricing)."""
    cfg = EVM_CHAINS["robinhood"]
    q = _evm_w3["robinhood"].eth.contract(address=cfg["v4_quoter"], abi=_V4_QUOTER_ABI)
    def f(stock, raw):
        st = Web3.to_checksum_address(stock)
        c0, c1 = (RH_USDG, st) if int(RH_USDG, 16) < int(st, 16) else (st, RH_USDG)
        z4o = (c0.lower() == st.lower())  # selling stock -> usdg
        try:
            out, _ = q.functions.quoteExactInputSingle(
                ((c0, c1, RH_STOCK_FEE, RH_STOCK_TS, _ZERO_ADDR), z4o, int(raw), b"")).call()
            return int(out)
        except Exception:
            return None
    return f

def buy_stock(pk_hex: str, stock: str, eth_amount: float,
              slippage_pct: float | None = None,
              priority_gwei: float | None = None) -> tuple[bool, str]:
    """ETH -> USDG -> STOCK. WRAP_ETH then multi-hop V4_SWAP, UR pays WETH."""
    try:
        chain = "robinhood"
        client = _evm_w3[chain]; cfg = EVM_CHAINS[chain]
        weth = cfg["weth"]; acc = EthAccount.from_key(pk_hex)
        st = Web3.to_checksum_address(stock)
        amt = Web3.to_wei(eth_amount, "ether")

        slip = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        exp = stock_quote_buy(st, eth_amount)
        min_out = int(exp * (1 - min(90.0, max(0.0, slip)) / 100.0)) if exp else 0

        path = [(RH_USDG, RH_BRIDGE_FEE, RH_BRIDGE_TS, _ZERO_ADDR, b""),
                (st, RH_STOCK_FEE, RH_STOCK_TS, _ZERO_ADDR, b"")]
        v4_input = _v4_encode_multihop_input(
            currency_in=weth, path=path, amount_in=amt, amount_out_min=min_out,
            currency_out=st, take_recipient=acc.address, payer_is_user=False)

        ur = client.eth.contract(address=cfg["universal_router"], abi=UNIVERSAL_ROUTER_ABI)
        wrap_input = _encode_wrap_eth_input(UR_ADDR_THIS, amt)
        commands = bytes([UR_CMD_WRAP_ETH, UR_CMD_V4_SWAP])
        inputs = [wrap_input, v4_input]
        deadline = int(client.eth.get_block("latest").timestamp) + 600

        fn = ur.functions.execute(commands, inputs, deadline)
        try:
            est = fn.estimate_gas({"from": acc.address, "value": amt})
            gas = max(400_000, min(1_800_000, int(est * 3 // 2)))
        except Exception as e:
            gas = 1_200_000
            logger.warning("stock buy gas est failed (%s), using %s", e, gas)
        tx_base = {"from": acc.address, "value": amt, "gas": gas,
                   "nonce": client.eth.get_transaction_count(acc.address),
                   "chainId": cfg["chain_id"]}
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        tx = fn.build_transaction(tx_base)
        signed = client.eth.account.sign_transaction(tx, pk_hex)
        tx_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        receipt = client.eth.wait_for_transaction_receipt(tx_hash, timeout=EVM_RECEIPT_TIMEOUT)
        if receipt.status == 1:
            return True, _tx0x(tx_hash)
        return False, (f"Stock buy reverted. "
                       f"<a href='{cfg['explorer_tx']}{_tx0x(tx_hash)}'>View tx</a>")
    except Exception as e:
        logger.error("buy_stock error: %s", e)
        return False, humanize_eth_error(e)

def sell_stock(pk_hex: str, stock: str, pct: int,
               slippage_pct: float | None = None,
               priority_gwei: float | None = None) -> tuple[bool, str]:
    """STOCK -> USDG -> ETH. Approve Permit2/UR, multi-hop V4_SWAP, UNWRAP_WETH."""
    try:
        chain = "robinhood"
        client = _evm_w3[chain]; cfg = EVM_CHAINS[chain]
        weth = cfg["weth"]; acc = EthAccount.from_key(pk_hex)
        st = Web3.to_checksum_address(stock)
        bal = get_evm_token_balance_raw(acc.address, st, chain)
        amt = bal if pct >= 100 else (bal * pct) // 100
        if amt <= 0:
            return False, "No shares to sell"

        # Approve Permit2 + Universal Router to pull the stock token.
        _v4_ensure_permit2_approved(client, acc, st, chain, amt)

        exp = stock_quote_sell(st, amt)
        slip = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        min_out = int(exp * (1 - min(90.0, max(0.0, slip)) / 100.0)) if exp else 0

        # UR takes WETH from the last hop; UNWRAP_WETH sends native ETH to user.
        path = [(RH_USDG, RH_STOCK_FEE, RH_STOCK_TS, _ZERO_ADDR, b""),
                (weth, RH_BRIDGE_FEE, RH_BRIDGE_TS, _ZERO_ADDR, b"")]
        v4_input = _v4_encode_multihop_input(
            currency_in=st, path=path, amount_in=amt, amount_out_min=min_out,
            currency_out=weth, take_recipient=UR_ADDR_THIS, payer_is_user=True)
        unwrap_input = _encode_unwrap_weth_input(acc.address, min_out)
        commands = bytes([UR_CMD_V4_SWAP, UR_CMD_UNWRAP_WETH])
        inputs = [v4_input, unwrap_input]
        deadline = int(client.eth.get_block("latest").timestamp) + 600

        ur = client.eth.contract(address=cfg["universal_router"], abi=UNIVERSAL_ROUTER_ABI)
        fn = ur.functions.execute(commands, inputs, deadline)
        try:
            est = fn.estimate_gas({"from": acc.address})
            gas = max(400_000, min(1_800_000, int(est * 3 // 2)))
        except Exception as e:
            gas = 1_200_000
            logger.warning("stock sell gas est failed (%s), using %s", e, gas)
        tx_base = {"from": acc.address, "gas": gas,
                   "nonce": client.eth.get_transaction_count(acc.address),
                   "chainId": cfg["chain_id"]}
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        tx = fn.build_transaction(tx_base)
        signed = client.eth.account.sign_transaction(tx, pk_hex)
        tx_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        receipt = client.eth.wait_for_transaction_receipt(tx_hash, timeout=EVM_RECEIPT_TIMEOUT)
        if receipt.status == 1:
            return True, _tx0x(tx_hash)
        return False, (f"Stock sell reverted. "
                       f"<a href='{cfg['explorer_tx']}{_tx0x(tx_hash)}'>View tx</a>")
    except Exception as e:
        logger.error("sell_stock error: %s", e)
        return False, humanize_eth_error(e)

# ############################################################################
# UNIFIED BUY/SELL: auto-route a token across V4 -> V3 -> V2. Start here for
# trading an arbitrary token; it picks the venue. Stocks are handled inside
# evm_sell_tokens' guard (they must use the USDG route, never a WETH pool).
# ############################################################################
def evm_buy_tokens(pk_hex: str, token: str, amount: float,
                    chain: str = "eth",
                    v4_route: dict | None = None,
                    slippage_pct: float | None = None,
                    priority_gwei: float | None = None) -> tuple[bool, str]:
    """If `v4_route` is supplied (pre-computed by the caller, e.g. the
    channel-level detect), use it directly and skip the per-call detect —
    saves a DexScreener fetch + getLogs scan on every follower's buy.

    slippage_pct / priority_gwei: per-follow overrides; None = use defaults.
    """
    # V4 route — Base only in v1. _v4_detect returns None for non-V4 pools
    # (we fall through to V2). Hooked V4 pools are now allowed; estimate_gas
    # in the V4 path catches malicious hooks before broadcast.
    if v4_route and v4_route.get("pool_key"):
        return evm_v4_buy_tokens(pk_hex, token, amount, chain, v4_route,
                                   slippage_pct=slippage_pct,
                                   priority_gwei=priority_gwei)
    if _v4_supported(chain):
        route = _v4_detect(token, chain)
        if route and route.get("pool_key"):
            return evm_v4_buy_tokens(pk_hex, token, amount, chain, route,
                                       slippage_pct=slippage_pct,
                                       priority_gwei=priority_gwei)

    # V3 route — chains with a v3_router (Robinhood). Deepest DexScreener pair
    # is V3 → route through SwapRouter02; otherwise fall through to V2.
    if _v3_supported(chain):
        v3 = _v3_detect(token, chain)
        if v3:
            return evm_v3_buy_tokens(pk_hex, token, amount, chain, v3,
                                       slippage_pct=slippage_pct,
                                       priority_gwei=priority_gwei)

    try:
        client   = _evm_w3[chain]
        cfg      = EVM_CHAINS[chain]
        acc      = EthAccount.from_key(pk_hex)
        tkn      = Web3.to_checksum_address(token)
        router   = client.eth.contract(address=cfg["router"], abi=UNISWAP_V2_ROUTER_ABI)
        amt      = Web3.to_wei(amount, "ether")
        path     = [cfg["weth"], tkn]
        deadline = int(client.eth.get_block("latest").timestamp) + 1000
        slip     = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        try:
            tokens_out = int(router.functions.getAmountsOut(int(amt), path).call()[-1])
        except Exception:
            tokens_out = None
        guard_err = _evm_buy_impact_error(chain, token, amt, tokens_out)
        if guard_err:
            return False, guard_err
        amount_out_min = _v2_amount_out_min(
            client, cfg["router"], amt, path, slip)
        swap_fn  = router.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(
            amount_out_min, path, acc.address, deadline)
        # Dynamic gas — tax tokens can do heavy work in transfer(). Estimate
        # per-tx with a 1.5x buffer; fall back to 700k if estimate reverts.
        try:
            est = swap_fn.estimate_gas({"from": acc.address, "value": amt})
            gas_limit = max(200_000, min(1_000_000, int(est * 3 // 2)))
        except Exception as e:
            gas_limit = 700_000
            logger.warning("evm_buy (%s): gas estimate failed (%s), using %s",
                            chain, e, gas_limit)
        tx_base = {
            "from":     acc.address,
            "value":    amt,
            "gas":      gas_limit,
            "nonce":    client.eth.get_transaction_count(acc.address),
            "chainId":  cfg["chain_id"],
        }
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        txn = swap_fn.build_transaction(tx_base)
        signed  = client.eth.account.sign_transaction(txn, pk_hex)
        tx_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        try:
            receipt = client.eth.wait_for_transaction_receipt(
                tx_hash, timeout=EVM_RECEIPT_TIMEOUT)
            if receipt.status == 1:
                return True, _tx0x(tx_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (f"The buy didn't go through. "
                            f"<a href='{tx_url}'>View tx</a>")
        except Exception:
            tx_url = f"{cfg['explorer_tx']}{_tx0x(tx_hash)}"
            return False, (
                f"The buy is still pending after {EVM_RECEIPT_TIMEOUT}s. "
                f"Don't try again — wait a minute and "
                f"<a href='{tx_url}'>check it here</a>.")
    except Exception as e:
        logger.error("evm_buy (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

_NATIVE_PRICE_REFS = {
    "sol": ("solana",   "So11111111111111111111111111111111111111112"),
    "eth": ("ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    "base": ("ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    # Robinhood native is ETH — reuse the mainnet ETH/USD reference.
    "robinhood": ("ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
}

_NATIVE_PRICE_CACHE: dict[str, tuple[float, float]] = {}

_NATIVE_PRICE_TTL = 30

def get_native_price_usd(chain: str) -> float | None:
    """Live USD price of the native token of `chain`, cached for 30s.
    Returns None if DexScreener is unreachable / has no pairs."""
    now = time.time()
    cached = _NATIVE_PRICE_CACHE.get(chain)
    if cached and cached[1] > now:
        return cached[0]
    ref = _NATIVE_PRICE_REFS.get(chain)
    if not ref:
        return None
    chain_id, token = ref
    try:
        resp = requests.get(
            f"https://api.dexscreener.com/latest/dex/tokens/{token}", timeout=10)
        if resp.status_code != 200:
            return cached[0] if cached else None
        pairs = resp.json().get("pairs") or []
        # Pick the pair on the right chain with the deepest USD liquidity.
        best_price = None
        best_liq   = -1.0
        for p in pairs:
            if p.get("chainId") != chain_id:
                continue
            try:
                price = float(p.get("priceUsd") or 0)
                liq   = float((p.get("liquidity") or {}).get("usd") or 0)
            except (TypeError, ValueError):
                continue
            if price > 0 and liq > best_liq:
                best_price, best_liq = price, liq
        if best_price is None:
            return cached[0] if cached else None
        _NATIVE_PRICE_CACHE[chain] = (best_price, now + _NATIVE_PRICE_TTL)
        return best_price
    except Exception as e:
        logger.warning("native price fetch failed for %s: %s", chain, e)
        return cached[0] if cached else None

def flash_gas_buffer(chain: str) -> float:
    """Extra native the user needs on top of dest_amount so they have gas
    for the FlashBuy's swap AND one future sell from the same wallet.
    Conservative: budgets ~500k gas per swap at the current network rate.
    Without this, the credited ETH/SOL would barely cover the buy itself
    and leave nothing for a later manual sell."""
    if chain == "sol":
        # PumpPortal buy & sell each carry a 0.005 SOL priority fee + dust.
        return 0.012
    try:
        per_swap = float(Web3.from_wei(_evm_gas_price(chain) * 500_000, "ether"))
    except Exception:
        per_swap = 0.005 if chain == "eth" else 0.0001
    return per_swap * 2

# ############################################################################
# BRIDGE (FlashBuy): move value between chains via hot wallets. Multi-chain
# (SOL<->EVM); the SOL branches are why solana/solders are imported.
# ############################################################################
def flash_quote(dest_chain: str, dest_amount: float,
                 source_chain: str) -> tuple[float | None, float, str | None]:
    """Convert `dest_amount` (the value the user wants to swap on the
    destination chain) into the source chain amount the user must pay,
    inclusive of the gas pre-load and FLASH_FEE_PCT spread.
    Returns (source_amount, gas_buffer, error)."""
    if dest_chain == source_chain:
        return None, 0.0, "Source and destination chains must be different."
    dest_usd_per_unit = get_native_price_usd(dest_chain)
    src_usd_per_unit  = get_native_price_usd(source_chain)
    if not dest_usd_per_unit or not src_usd_per_unit:
        return None, 0.0, "Couldn't fetch live prices. Try again in a moment."
    gas_buf   = flash_gas_buffer(dest_chain)
    # USD value the user is actually receiving on the destination chain
    # (swap value + gas pre-load), then apply our spread.
    total_dest = dest_amount + gas_buf
    usd_value  = total_dest * dest_usd_per_unit
    src_amount = usd_value * (1.0 + FLASH_FEE_PCT / 100.0) / src_usd_per_unit
    return src_amount, gas_buf, None

def flash_hot_addresses() -> dict[str, str]:
    """Hot-wallet public addresses for the credit/debit endpoints, derived
    from the env-supplied private keys. Empty string for chains not configured."""
    out = {"sol": "", "eth": "", "base": "", "robinhood": ""}
    if FLASH_HOT_SOL_PRIVATE_KEY:
        try:
            out["sol"] = str(SolKeypair.from_bytes(
                base58.b58decode(FLASH_HOT_SOL_PRIVATE_KEY)).pubkey())
        except Exception as e:
            logger.error("FlashBuy: bad SOL hot key: %s", e)
    if FLASH_HOT_EVM_PRIVATE_KEY:
        try:
            addr = EthAccount.from_key(FLASH_HOT_EVM_PRIVATE_KEY).address
            out["eth"]  = addr
            out["base"] = addr  # same key works on every EVM chain
            out["robinhood"] = addr
            # NOTE: this only wires the FEE SWEEP destination. FlashBuy routing
            # stays gated by FLASH_SUPPORTED_CHAINS ({"sol","eth"}), so adding
            # robinhood here does not open a bridge path.
        except Exception as e:
            logger.error("FlashBuy: bad EVM hot key: %s", e)
    return out

def flash_hot_balance(chain: str) -> float:
    """Native balance held by the FlashBuy hot wallet on `chain`."""
    addrs = flash_hot_addresses()
    addr  = addrs.get(chain) or ""
    if not addr:
        return 0.0
    if chain == "sol":
        return get_sol_balance(addr)
    return get_evm_balance(addr, chain)

def _flash_hot_key(chain: str) -> str:
    return (FLASH_HOT_SOL_PRIVATE_KEY if chain == "sol"
            else FLASH_HOT_EVM_PRIVATE_KEY)

def flash_debit_user(user_pk: str, user_addr: str, source_chain: str,
                      amount: float) -> tuple[bool, str]:
    """Pull `amount` of `source_chain` native from user_addr → hot wallet.
    Waits for confirmation. Returns (ok, tx_or_error)."""
    addrs = flash_hot_addresses()
    to    = addrs.get(source_chain) or ""
    if not to:
        return False, f"FlashBuy hot wallet for {source_chain.upper()} isn't configured."
    if source_chain == "sol":
        return send_sol(user_pk, to, amount)
    return evm_send(user_pk, to, amount, source_chain)

def flash_credit_user(user_addr: str, dest_chain: str,
                       amount: float) -> tuple[bool, str]:
    """Send `amount` of dest_chain native from hot wallet → user. Waits."""
    key = _flash_hot_key(dest_chain)
    if not key:
        return False, f"FlashBuy hot wallet for {dest_chain.upper()} isn't configured."
    if dest_chain == "sol":
        return send_sol(key, user_addr, amount)
    return evm_send(key, user_addr, amount, dest_chain)

def evm_sell_tokens(pk_hex: str, token: str, pct: int,
                     chain: str = "eth",
                     v4_route: dict | None = None,
                     slippage_pct: float | None = None,
                     priority_gwei: float | None = None) -> tuple[bool, str]:
    """If `v4_route` is supplied by the caller, skip the per-call detect.

    slippage_pct / priority_gwei: per-follow overrides; None = use defaults.
    """
    # Tokenized stocks pair against USDG, not WETH. A generic sell (e.g. from
    # the Positions screen) would otherwise route into a fake WETH pool and
    # dump for ~nothing. Always take the correct 2-hop USDG route.
    if chain == "robinhood" and is_stock(token):
        return sell_stock(pk_hex, token, pct,
                          slippage_pct=slippage_pct, priority_gwei=priority_gwei)

    # V4 route — Base only in v1.
    if v4_route and v4_route.get("pool_key"):
        return evm_v4_sell_tokens(pk_hex, token, pct, chain, v4_route,
                                    slippage_pct=slippage_pct,
                                    priority_gwei=priority_gwei)
    if _v4_supported(chain):
        route = _v4_detect(token, chain)
        if route and route.get("pool_key"):
            return evm_v4_sell_tokens(pk_hex, token, pct, chain, route,
                                        slippage_pct=slippage_pct,
                                        priority_gwei=priority_gwei)

    # V3 route — chains with a v3_router (Robinhood). Deepest pair is V3 →
    # SwapRouter02; otherwise fall through to V2.
    if _v3_supported(chain):
        v3 = _v3_detect(token, chain)
        if v3:
            return evm_v3_sell_tokens(pk_hex, token, pct, chain, v3,
                                        slippage_pct=slippage_pct,
                                        priority_gwei=priority_gwei)

    try:
        client = _evm_w3[chain]
        cfg    = EVM_CHAINS[chain]
        acc    = EthAccount.from_key(pk_hex)
        tkn    = Web3.to_checksum_address(token)
        tc     = client.eth.contract(address=tkn, abi=ERC20_ABI)
        router = client.eth.contract(address=cfg["router"], abi=UNISWAP_V2_ROUTER_ABI)

        logger.info("─── %s sell start ───", chain.upper())
        logger.info("  wallet:   %s", acc.address)
        logger.info("  token:    %s", tkn)
        logger.info("  router:   %s", cfg["router"])
        logger.info("  weth:     %s", cfg["weth"])
        logger.info("  pct:      %s%%", pct)

        try:
            decimals = tc.functions.decimals().call()
        except Exception as e:
            logger.error("  failed to read decimals: %s", e)
            decimals = 18
        logger.info("  decimals: %s", decimals)

        bal = tc.functions.balanceOf(acc.address).call()
        # Integer division — `bal * pct / 100` does float math and loses
        # precision for 18-decimal balances above 2^53 (~9e15 wei), causing
        # `amt` to round UP past the real balance. The router then reverts
        # with "TransferHelper: TRANSFER_FROM_FAILED".
        amt = (bal * pct) // 100
        # For a full 100% sell, clamp to the exact balance — never request a
        # single wei more than what the wallet actually holds.
        if pct >= 100:
            amt = bal
        logger.info("  balance:  %s wei  (%.6f tokens)", bal, bal / (10 ** decimals))
        logger.info("  amt:      %s wei  (%.6f tokens)", amt, amt / (10 ** decimals))
        if amt == 0:
            return False, "No tokens to sell"

        # ── V2 pool guard ────────────────────────────────────────────────
        # We only reach here after V4 + V3 detection both declined. On chains
        # with V3/V4 (Robinhood), a token may have NO V2 pool at all — sending
        # the V2 swap anyway reverts on-chain and burns the user's gas (this is
        # what happened to THROBBIN). Pre-flight getAmountsOut; if it reverts
        # there's no V2 route, so fail clean with an actionable message instead
        # of broadcasting a doomed transaction.
        if _v3_supported(chain):
            try:
                router.functions.getAmountsOut(int(amt), [tkn, cfg["weth"]]).call()
            except Exception:
                logger.warning("  no V2 pool for %s on %s — refusing doomed sell",
                               tkn, chain)
                return False, (
                    "Couldn't find a sellable pool for this token right now. "
                    "This is usually a temporary price-feed hiccup — wait a "
                    "moment and try again.")

        nonce = client.eth.get_transaction_count(acc.address)
        gp    = _evm_gas_price(chain)
        logger.info("  nonce:    %s", nonce)
        logger.info("  gasPrice: %s wei  (%.4f gwei)", gp, gp / 1e9)

        # ── Step 1: approve the router if allowance is too low ───────────
        allowance = tc.functions.allowance(acc.address, cfg["router"]).call()
        logger.info("  allowance: %s wei", allowance)
        if allowance < amt:
            logger.info("  → approve needed; sending approve tx")
            ap = tc.functions.approve(cfg["router"], 2**256 - 1).build_transaction(
                {"from": acc.address, "gas": 100_000, "gasPrice": gp,
                 "nonce": nonce, "chainId": cfg["chain_id"]})
            sa      = client.eth.account.sign_transaction(ap, pk_hex)
            ap_hash = _broadcast_evm_tx(sa.raw_transaction, chain)
            logger.info("  approve tx: %s", _tx0x(ap_hash))
            try:
                receipt = client.eth.wait_for_transaction_receipt(
                    ap_hash, timeout=EVM_APPROVE_TIMEOUT)
            except Exception as e:
                logger.error("  approve wait timeout: %s", e)
                ap_url = f"{cfg['explorer_tx']}{_tx0x(ap_hash)}"
                return False, (
                    f"Approving the token for selling is taking longer than "
                    f"{EVM_APPROVE_TIMEOUT}s. Wait a minute, then try selling again. "
                    f"<a href='{ap_url}'>View approval</a>")
            logger.info("  approve receipt status: %s  block: %s",
                        receipt.status, receipt.blockNumber)
            if receipt.status != 1:
                ap_url = f"{cfg['explorer_tx']}{_tx0x(ap_hash)}"
                return False, (f"Approving the token for selling didn't go through. "
                                f"<a href='{ap_url}'>View tx</a>")
            nonce += 1
        else:
            logger.info("  → approve skipped (allowance sufficient)")

        # ── Step 2: quote (informational only) ───────────────────────────
        path = [tkn, cfg["weth"]]
        try:
            quote = router.functions.getAmountsOut(amt, path).call()
            logger.info("  getAmountsOut: %s", quote)
            logger.info("  expected native out (no tax): %.8f", quote[1] / 1e18)
        except Exception as e:
            logger.warning("  getAmountsOut failed: %s", e)

        # ── Step 3: pre-flight eth_call simulation (informational) ──────
        deadline = int(client.eth.get_block("latest").timestamp) + 1000
        slip = EVM_DEFAULT_SLIPPAGE_PCT if slippage_pct is None else slippage_pct
        amount_out_min = _v2_amount_out_min(
            client, cfg["router"], amt, path, slip)
        swap_fn  = router.functions.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amt, amount_out_min, path, acc.address, deadline)
        try:
            swap_fn.call({"from": acc.address})
            logger.info("  eth_call simulation: OK")
        except Exception as e:
            logger.error("  eth_call simulation REVERTED: %s", e)

        # ── Step 4: gas estimate + 1.5× buffer ──────────────────────────
        # Some tax / anti-MEV tokens do heavy work in transfer() (tax
        # distribution, anti-snipe, multi-hop fees). A static 300k limit ran
        # out on tokens like that. Estimate per-tx and pad generously; fall
        # back to a known-safe 700k if estimateGas itself reverts.
        try:
            est = swap_fn.estimate_gas({"from": acc.address})
            gas_limit = max(200_000, min(1_000_000, int(est * 3 // 2)))
            logger.info("  gas: estimate=%s, limit=%s", est, gas_limit)
        except Exception as e:
            gas_limit = 700_000
            logger.warning("  gas: estimate failed (%s), using %s", e, gas_limit)

        # ── Step 5: submit ───────────────────────────────────────────────
        tx_base = {
            "from": acc.address, "gas": gas_limit,
            "nonce": nonce, "chainId": cfg["chain_id"],
        }
        tx_base.update(_evm_tx_fees(chain, priority_gwei))
        txn = swap_fn.build_transaction(tx_base)
        signed    = client.eth.account.sign_transaction(txn, pk_hex)
        swap_hash = _broadcast_evm_tx(signed.raw_transaction, chain)
        logger.info("  swap tx: %s", _tx0x(swap_hash))
        try:
            receipt = client.eth.wait_for_transaction_receipt(
                swap_hash, timeout=EVM_RECEIPT_TIMEOUT)
            logger.info("  swap receipt status: %s  block: %s  gas used: %s",
                        receipt.status, receipt.blockNumber, receipt.gasUsed)
            if receipt.status == 1:
                return True, _tx0x(swap_hash)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(swap_hash)}"
            return False, (f"The sell didn't go through. "
                            f"<a href='{tx_url}'>View tx</a>")
        except Exception as e:
            logger.error("  swap receipt timeout: %s", e)
            tx_url = f"{cfg['explorer_tx']}{_tx0x(swap_hash)}"
            return False, (
                f"The sell is still pending after {EVM_RECEIPT_TIMEOUT}s. "
                f"Don't try again — wait a minute and "
                f"<a href='{tx_url}'>check it here</a>.")
    except Exception as e:
        logger.error("evm_sell (%s) error: %s", chain, e)
        return False, humanize_eth_error(e)

_DEXSCREENER_TO_CHAIN = {
    "ethereum":  "eth",
    "base":      "base",
    "solana":    "sol",
    "robinhood": "robinhood",
}

_CHAIN_TO_DEXSCREENER = {v: k for k, v in _DEXSCREENER_TO_CHAIN.items()}

_DEX_TOKEN_CACHE: dict[tuple[str, str], tuple[dict | None, float]] = {}

_DEX_PAIR_CACHE:  dict[tuple[str, str], tuple[dict | None, float]] = {}

_DEX_CACHE_TTL_S = 30

def _cache_get(cache: dict, key: tuple) -> tuple[bool, dict | None]:
    """(hit, value). hit=False means caller should fetch fresh."""
    entry = cache.get(key)
    if not entry:
        return False, None
    value, ts = entry
    if time.time() - ts > _DEX_CACHE_TTL_S:
        cache.pop(key, None)
        return False, None
    return True, value

def _cache_put(cache: dict, key: tuple, value) -> None:
    cache[key] = (value, time.time())
    # Trim opportunistically so we don't grow unboundedly across hot tokens.
    if len(cache) > 512:
        cutoff = time.time() - _DEX_CACHE_TTL_S
        for k, (_, ts) in list(cache.items()):
            if ts < cutoff:
                cache.pop(k, None)

def get_token_info(address: str, chain: str | None = None) -> dict | None:
    key = ((chain or "").lower(), address.lower())
    hit, cached = _cache_get(_DEX_TOKEN_CACHE, key)
    if hit:
        return cached
    try:
        resp  = requests.get(
            f"https://api.dexscreener.com/latest/dex/tokens/{address}", timeout=10)
        if resp.status_code != 200:
            return None
        pairs = resp.json().get("pairs") or []
        if not pairs:
            _cache_put(_DEX_TOKEN_CACHE, key, None)
            return None
        if chain in _CHAIN_TO_DEXSCREENER:
            wanted   = _CHAIN_TO_DEXSCREENER[chain]
            filtered = [p for p in pairs if p.get("chainId") == wanted]
        else:
            filtered = pairs
        # Pick the DEEPEST-liquidity pair, not pairs[0]. The first pair can be
        # a thin/stale pool whose price mis-values the position (a near-zero
        # price reads as a −100 % loss on a token the user is actually up on).
        def _pair_liq(p: dict) -> float:
            try:
                return float((p.get("liquidity") or {}).get("usd") or 0)
            except (TypeError, ValueError):
                return 0.0
        candidates = filtered or pairs
        pair = max(candidates, key=_pair_liq)
        info = {
            "name":        pair.get("baseToken", {}).get("name",   "Unknown"),
            "symbol":      pair.get("baseToken", {}).get("symbol", "???"),
            "address":     address,
            "chain":       _DEXSCREENER_TO_CHAIN.get(pair.get("chainId", ""), "unknown"),
            "marketCap":   pair.get("marketCap"),
            "priceUsd":    pair.get("priceUsd"),
            "priceNative": pair.get("priceNative"),
        }
        _cache_put(_DEX_TOKEN_CACHE, key, info)
        return info
    except Exception as e:
        logger.error("token info error for %s: %s", address[:12], e)
        return None
