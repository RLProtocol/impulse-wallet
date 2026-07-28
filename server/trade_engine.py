"""Build-only trade engine for Strix Wallet.

Reuses the REAL Robinhood trading logic from robinhoodcode.py (the Uniswap
V4/V3/V2 encoders, pool detection, stock USDG routing, quoters) but stops
before signing: every action returns an UNSIGNED transaction {to,data,value,gas}
that the wallet extension signs locally and broadcasts. Keys never touch the
server.
"""
import _bootstrap  # noqa: F401  — stub heavy unused deps before importing rh
import time
from concurrent.futures import ThreadPoolExecutor

import robinhoodcode as rh

CHAIN = "robinhood"


def _client():
    return rh._evm_w3[CHAIN]


def _cfg():
    return rh.EVM_CHAINS[CHAIN]


def _cs(addr: str) -> str:
    return rh.Web3.to_checksum_address(addr)


def _slip(v) -> float:
    try:
        return max(0.0, min(90.0, float(v)))
    except Exception:
        return rh.EVM_DEFAULT_SLIPPAGE_PCT


# ── low-level: turn a bound contract fn into an unsigned tx dict ─────────────
def _tx(fn, from_addr: str, gas: int, value: int = 0) -> dict:
    """Build calldata for `fn` and return {to,data,value,gas}. The wallet fills
    nonce + fees itself via viem, so those fields are intentionally omitted."""
    cfg = _cfg()
    tx_base = {
        "from": from_addr,
        "gas": int(gas),
        "nonce": _client().eth.get_transaction_count(from_addr),
        "chainId": cfg["chain_id"],
        "gasPrice": rh._evm_gas_price(CHAIN),
    }
    if value:
        tx_base["value"] = int(value)
    built = fn.build_transaction(tx_base)
    data = built.get("data") or built.get("input") or "0x"
    if isinstance(data, (bytes, bytearray)):
        data = "0x" + bytes(data).hex()
    return {
        "to": _cs(built["to"]),
        "data": data if str(data).startswith("0x") else "0x" + str(data),
        "value": str(int(built.get("value", 0))),
        "gas": str(int(built["gas"])),
    }


def _est(fn, from_addr: str, value: int, fallback: int, lo: int, hi: int) -> int:
    try:
        params = {"from": from_addr}
        if value:
            params["value"] = int(value)
        est = fn.estimate_gas(params)
        return max(lo, min(hi, int(est * 3 // 2)))
    except Exception:
        return fallback


def _deadline() -> int:
    return int(_client().eth.get_block("latest").timestamp) + 600


# ── approvals (build-only) ──────────────────────────────────────────────────
def _erc20_approval_tx(from_addr: str, token: str, spender: str, amount_min: int):
    """Return [approve tx] if ERC20 allowance(from, spender) < amount, else []."""
    tc = _client().eth.contract(address=_cs(token), abi=rh.ERC20_ABI)
    cur = tc.functions.allowance(from_addr, _cs(spender)).call()
    if cur >= amount_min:
        return []
    fn = tc.functions.approve(_cs(spender), 2**256 - 1)
    return [_tx(fn, from_addr, gas=100_000)]


def _permit2_approval_txs(from_addr: str, token: str, amount_min: int):
    """Permit2 flow: (1) ERC20.approve(Permit2) if needed, (2) Permit2.approve(UR)
    if allowance is low or near expiry. Returns the txs the user must sign first."""
    cfg = _cfg()
    permit2_addr = cfg["permit2"]
    ur_addr = cfg["universal_router"]
    token = _cs(token)
    txs = []

    erc20 = _client().eth.contract(address=token, abi=rh.ERC20_APPROVE_ABI)
    if erc20.functions.allowance(from_addr, permit2_addr).call() < amount_min:
        fn = erc20.functions.approve(permit2_addr, 2**256 - 1)
        txs.append(_tx(fn, from_addr, gas=100_000))

    permit2 = _client().eth.contract(address=permit2_addr, abi=rh.PERMIT2_ABI)
    cur_amt, expiration, _nonce = permit2.functions.allowance(from_addr, token, ur_addr).call()
    now = int(_client().eth.get_block("latest").timestamp)
    if cur_amt < amount_min or expiration < now + 60:
        new_exp = now + 30 * 24 * 3600
        fn = permit2.functions.approve(token, ur_addr, 2**160 - 1, new_exp)
        txs.append(_tx(fn, from_addr, gas=120_000))
    return txs


# ── sell amount helper ──────────────────────────────────────────────────────
def _sell_amount(from_addr: str, token: str, pct: int) -> int:
    bal = rh.get_evm_token_balance_raw(from_addr, _cs(token), CHAIN)
    if bal <= 0:
        raise ValueError("No balance to sell.")
    amt = bal if int(pct) >= 100 else (bal * int(pct)) // 100
    if amt <= 0:
        raise ValueError("Sell amount rounds to zero — try a larger %.")
    return amt


# ════════════════════════ GENERIC TOKEN: BUY ═══════════════════════════════
def build_buy(ca: str, amount_eth: str, from_addr: str, slippage=None) -> dict:
    cfg = _cfg()
    tkn = _cs(ca)
    from_addr = _cs(from_addr)
    slip = _slip(slippage)
    amt = rh.Web3.to_wei(str(amount_eth), "ether")

    # V4 → V3 → V2, mirroring evm_buy_tokens dispatch.
    if rh._v4_supported(CHAIN):
        route = rh._v4_detect(tkn, CHAIN)
        if route and route.get("pool_key"):
            return _v4_buy(tkn, amt, from_addr, route)

    if rh._v3_supported(CHAIN):
        v3 = rh._v3_detect(tkn, CHAIN)
        if v3:
            return _v3_buy(tkn, amt, from_addr, v3, slip)

    return _v2_buy(tkn, amt, from_addr, slip)


def _v4_buy(tkn, amt, from_addr, route) -> dict:
    cfg = _cfg()
    weth = cfg["weth"]
    pool_key = route["pool_key"]
    uses_weth = rh._v4_pool_uses_weth(pool_key, weth)
    currency_in = weth if uses_weth else rh.V4_ETH_SENTINEL
    zero_for_one = (pool_key["currency0"].lower() == currency_in.lower())
    v4_input = rh._v4_encode_swap_input(
        pool_key=pool_key, zero_for_one=zero_for_one, amount_in=amt,
        amount_out_min=0, currency_in=currency_in, currency_out=tkn,
        payer_is_user=not uses_weth)
    ur = _client().eth.contract(address=cfg["universal_router"], abi=rh.UNIVERSAL_ROUTER_ABI)
    if uses_weth:
        commands = bytes([rh.UR_CMD_WRAP_ETH, rh.UR_CMD_V4_SWAP])
        inputs = [rh._encode_wrap_eth_input(rh.UR_ADDR_THIS, amt), v4_input]
    else:
        commands = bytes([rh.UR_CMD_V4_SWAP])
        inputs = [v4_input]
    fn = ur.functions.execute(commands, inputs, _deadline())
    gas = _est(fn, from_addr, amt, 900_000, 300_000, 1_500_000)
    return {"txs": [_tx(fn, from_addr, gas, value=amt)], "venue": "v4"}


def _v3_buy(tkn, amt, from_addr, route, slip) -> dict:
    cfg = _cfg()
    router = _client().eth.contract(address=cfg["v3_router"], abi=rh.V3_SWAPROUTER02_ABI)
    fee = int(route["fee"])
    min_out = rh._v3_amount_out_min(_client(), cfg["v3_quoter"], cfg["weth"], tkn, fee, amt, slip)
    fn = router.functions.exactInputSingle((cfg["weth"], tkn, fee, from_addr, amt, min_out, 0))
    gas = _est(fn, from_addr, amt, 700_000, 200_000, 1_000_000)
    return {"txs": [_tx(fn, from_addr, gas, value=amt)], "venue": "v3"}


def _v2_buy(tkn, amt, from_addr, slip) -> dict:
    cfg = _cfg()
    router = _client().eth.contract(address=cfg["router"], abi=rh.UNISWAP_V2_ROUTER_ABI)
    path = [cfg["weth"], tkn]
    min_out = rh._v2_amount_out_min(_client(), cfg["router"], amt, path, slip)
    fn = router.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(
        min_out, path, from_addr, _deadline() + 400)
    gas = _est(fn, from_addr, amt, 700_000, 200_000, 1_000_000)
    return {"txs": [_tx(fn, from_addr, gas, value=amt)], "venue": "v2"}


# ════════════════════════ GENERIC TOKEN: SELL ══════════════════════════════
def build_sell(ca: str, pct: int, from_addr: str, slippage=None) -> dict:
    tkn = _cs(ca)
    from_addr = _cs(from_addr)
    slip = _slip(slippage)

    # Stocks route through USDG — never sell them as a generic WETH pair.
    if rh.is_stock(tkn):
        return build_stock_sell(tkn, pct, from_addr, slippage)

    amt = _sell_amount(from_addr, tkn, pct)

    if rh._v4_supported(CHAIN):
        route = rh._v4_detect(tkn, CHAIN)
        if route and route.get("pool_key"):
            return _v4_sell(tkn, amt, from_addr, route)

    if rh._v3_supported(CHAIN):
        v3 = rh._v3_detect(tkn, CHAIN)
        if v3:
            return _v3_sell(tkn, amt, from_addr, v3, slip)

    return _v2_sell(tkn, amt, from_addr, slip)


def _v4_sell(tkn, amt, from_addr, route) -> dict:
    cfg = _cfg()
    weth = cfg["weth"]
    pool_key = route["pool_key"]
    uses_weth = rh._v4_pool_uses_weth(pool_key, weth)
    zero_for_one = (pool_key["currency0"].lower() == tkn.lower())
    currency_out = weth if uses_weth else rh.V4_ETH_SENTINEL
    take_recipient = rh.UR_ADDR_THIS if uses_weth else None
    v4_input = rh._v4_encode_swap_input(
        pool_key=pool_key, zero_for_one=zero_for_one, amount_in=amt,
        amount_out_min=0, currency_in=tkn, currency_out=currency_out,
        take_recipient=take_recipient)
    ur = _client().eth.contract(address=cfg["universal_router"], abi=rh.UNIVERSAL_ROUTER_ABI)
    if uses_weth:
        commands = bytes([rh.UR_CMD_V4_SWAP, rh.UR_CMD_UNWRAP_WETH])
        inputs = [v4_input, rh._encode_unwrap_weth_input(rh.UR_ADDR_SENDER, 0)]
    else:
        commands = bytes([rh.UR_CMD_V4_SWAP])
        inputs = [v4_input]
    fn = ur.functions.execute(commands, inputs, _deadline())
    approvals = _permit2_approval_txs(from_addr, tkn, amt)
    swap = _tx(fn, from_addr, gas=900_000)
    return {"txs": approvals + [swap], "venue": "v4"}


def _v3_sell(tkn, amt, from_addr, route, slip) -> dict:
    cfg = _cfg()
    router = _client().eth.contract(address=cfg["v3_router"], abi=rh.V3_SWAPROUTER02_ABI)
    fee = int(route["fee"])
    min_out = rh._v3_amount_out_min(_client(), cfg["v3_quoter"], tkn, cfg["weth"], fee, amt, slip)
    swap_call = router.functions.exactInputSingle((tkn, cfg["weth"], fee, rh._V3_ADDRESS_THIS, amt, min_out, 0))
    unwrap_call = router.functions.unwrapWETH9(min_out, from_addr)
    calls = [
        rh.Web3.to_bytes(hexstr=swap_call._encode_transaction_data()),
        rh.Web3.to_bytes(hexstr=unwrap_call._encode_transaction_data()),
    ]
    fn = router.functions.multicall(calls)
    approvals = _erc20_approval_tx(from_addr, tkn, cfg["v3_router"], amt)
    swap = _tx(fn, from_addr, gas=700_000)
    return {"txs": approvals + [swap], "venue": "v3"}


def _v2_sell(tkn, amt, from_addr, slip) -> dict:
    cfg = _cfg()
    router = _client().eth.contract(address=cfg["router"], abi=rh.UNISWAP_V2_ROUTER_ABI)
    path = [tkn, cfg["weth"]]
    min_out = rh._v2_amount_out_min(_client(), cfg["router"], amt, path, slip)
    fn = router.functions.swapExactTokensForETHSupportingFeeOnTransferTokens(
        amt, min_out, path, from_addr, _deadline() + 400)
    approvals = _erc20_approval_tx(from_addr, tkn, cfg["router"], amt)
    swap = _tx(fn, from_addr, gas=700_000)
    return {"txs": approvals + [swap], "venue": "v2"}


# ════════════════════════ STOCKS (USDG multi-hop) ══════════════════════════
def build_stock_buy(stock: str, amount_eth: str, from_addr: str, slippage=None) -> dict:
    cfg = _cfg()
    weth = cfg["weth"]
    st = _cs(stock)
    from_addr = _cs(from_addr)
    slip = _slip(slippage)
    amt = rh.Web3.to_wei(str(amount_eth), "ether")

    exp = rh.stock_quote_buy(st, float(amount_eth))
    min_out = int(exp * (1 - slip / 100.0)) if exp else 0
    path = [(rh.RH_USDG, rh.RH_BRIDGE_FEE, rh.RH_BRIDGE_TS, rh._ZERO_ADDR, b""),
            (st, rh.RH_STOCK_FEE, rh.RH_STOCK_TS, rh._ZERO_ADDR, b"")]
    v4_input = rh._v4_encode_multihop_input(
        currency_in=weth, path=path, amount_in=amt, amount_out_min=min_out,
        currency_out=st, take_recipient=from_addr, payer_is_user=False)
    ur = _client().eth.contract(address=cfg["universal_router"], abi=rh.UNIVERSAL_ROUTER_ABI)
    commands = bytes([rh.UR_CMD_WRAP_ETH, rh.UR_CMD_V4_SWAP])
    inputs = [rh._encode_wrap_eth_input(rh.UR_ADDR_THIS, amt), v4_input]
    fn = ur.functions.execute(commands, inputs, _deadline())
    gas = _est(fn, from_addr, amt, 1_200_000, 400_000, 1_800_000)
    return {"txs": [_tx(fn, from_addr, gas, value=amt)], "venue": "v4", "expectedOut": str(exp or 0)}


def build_stock_sell(stock: str, pct: int, from_addr: str, slippage=None) -> dict:
    cfg = _cfg()
    weth = cfg["weth"]
    st = _cs(stock)
    from_addr = _cs(from_addr)
    slip = _slip(slippage)

    amt = _sell_amount(from_addr, st, pct)
    exp = rh.stock_quote_sell(st, amt)
    min_out = int(exp * (1 - slip / 100.0)) if exp else 0

    path = [(rh.RH_USDG, rh.RH_STOCK_FEE, rh.RH_STOCK_TS, rh._ZERO_ADDR, b""),
            (weth, rh.RH_BRIDGE_FEE, rh.RH_BRIDGE_TS, rh._ZERO_ADDR, b"")]
    v4_input = rh._v4_encode_multihop_input(
        currency_in=st, path=path, amount_in=amt, amount_out_min=min_out,
        currency_out=weth, take_recipient=rh.UR_ADDR_THIS, payer_is_user=True)
    ur = _client().eth.contract(address=cfg["universal_router"], abi=rh.UNIVERSAL_ROUTER_ABI)
    commands = bytes([rh.UR_CMD_V4_SWAP, rh.UR_CMD_UNWRAP_WETH])
    inputs = [v4_input, rh._encode_unwrap_weth_input(from_addr, min_out)]
    fn = ur.functions.execute(commands, inputs, _deadline())
    approvals = _permit2_approval_txs(from_addr, st, amt)
    swap = _tx(fn, from_addr, gas=1_200_000)
    return {"txs": approvals + [swap], "venue": "v4", "expectedOut": str(exp or 0)}


# ════════════════════════ READS (info / prices / quotes) ═══════════════════
def _to_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def token_info(ca: str) -> dict:
    tkn = _cs(ca)
    is_stock = rh.is_stock(tkn)
    pair = None
    try:
        pair = rh._dexscreener_best_pair(tkn, CHAIN)
    except Exception:
        pair = None

    # decimals on-chain (best-effort)
    try:
        decimals = _client().eth.contract(address=tkn, abi=rh.ERC20_ABI).functions.decimals().call()
    except Exception:
        decimals = 18

    venue = "unknown"
    try:
        if rh._is_v4_pool(pair):
            venue = "v4"
        elif rh._is_v3_pool(pair):
            venue = "v3"
        elif pair:
            venue = "v2"
    except Exception:
        pass

    if not pair:
        # stocks may not be on dexscreener — still return a usable shell
        meta = rh.stock_by_address(tkn) if is_stock else None
        price = rh.stock_price_usd(tkn) if is_stock else None
        return {
            "address": tkn, "symbol": (meta[0] if meta else "TOKEN"),
            "name": (meta[1] if meta else "Token"), "decimals": int(decimals),
            "priceUsd": price, "priceNative": None, "mcap": None, "liquidityUsd": None,
            "priceChange24h": None, "volume24h": None, "venue": "v4" if is_stock else venue,
            "pairUrl": None, "isStock": is_stock, "logo": None,
        }

    base = pair.get("baseToken", {}) or {}
    liq = (pair.get("liquidity") or {}).get("usd")
    logo = (pair.get("info") or {}).get("imageUrl")
    return {
        "address": tkn,
        "symbol": base.get("symbol", "TOKEN"),
        "name": base.get("name", "Token"),
        "decimals": int(decimals),
        "logo": logo,
        "priceUsd": _to_float(pair.get("priceUsd")),
        "priceNative": _to_float(pair.get("priceNative")),
        "mcap": _to_float(pair.get("marketCap") or pair.get("fdv")),
        "liquidityUsd": _to_float(liq),
        "priceChange24h": _to_float((pair.get("priceChange") or {}).get("h24")),
        "volume24h": _to_float((pair.get("volume") or {}).get("h24")),
        "venue": "v4" if is_stock else venue,
        "pairUrl": pair.get("url"),
        "isStock": is_stock,
    }


def native_price() -> float:
    return rh.get_native_price_usd(CHAIN) or 0.0


_STOCK_CACHE: dict = {"t": 0.0, "data": None}
_STOCK_TTL = 15.0


def _stock_price_safe(addr: str):
    try:
        return rh.stock_price_usd(addr)
    except Exception:
        return None


def stock_list() -> list:
    # Cache to make repeat opens instant, and fetch the 8 prices concurrently so
    # the whole list returns in ~1s instead of ~7s (a Chrome popup closes on blur).
    now = time.time()
    if _STOCK_CACHE["data"] and now - _STOCK_CACHE["t"] < _STOCK_TTL:
        return _STOCK_CACHE["data"]

    items = list(rh.RH_STOCKS.items())  # [(sym, (addr, name)), ...]
    with ThreadPoolExecutor(max_workers=8) as ex:
        prices = list(ex.map(lambda kv: _stock_price_safe(kv[1][0]), items))

    out = [
        {"symbol": sym, "name": name, "address": _cs(addr), "priceUsd": pr}
        for (sym, (addr, name)), pr in zip(items, prices)
    ]
    _STOCK_CACHE.update(t=now, data=out)
    return out


def quote_buy(ca: str, amount_eth: str) -> dict:
    tkn = _cs(ca)
    if rh.is_stock(tkn):
        out = rh.stock_quote_buy(tkn, float(amount_eth))
        return {"expectedOut": str(out or 0), "decimals": 18, "venue": "v4"}
    # generic token: quote via detection + venue quoter
    amt = rh.Web3.to_wei(str(amount_eth), "ether")
    out = rh.quote_evm_token_to_native(tkn, amt, CHAIN) if hasattr(rh, "quote_evm_token_to_native") else None
    return {"expectedOut": str(out or 0), "decimals": 18, "venue": "unknown"}
