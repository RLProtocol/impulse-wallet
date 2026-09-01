// Impulse Wallet trade engine — 100% client-side (no backend API).
// Exposes the same `api` interface the UI used before, but every call runs
// locally: DexScreener for metadata/prices, viem for on-chain quotes + swap
// building. Faithful port of robinhoodcode.py's routing + encoders.

import { encodeFunctionData, getAddress, parseEther, type Address } from "viem";
import { publicClient, WETH, USDG, ERC20_ABI, RH_STOCKS, STOCK_BY_ADDR, isStock } from "./chain";
import type { UnsignedTx } from "./wallet";
import type { TokenInfo, TxBundle } from "./api";
import * as dx from "./dexcore";
import { CHAINS, cfgFor, clientFor, type ChainCfg, type ChainKey } from "./chains";
import * as sol from "./solana";
import * as rh from "./rhroute";
import * as pons from "./pons";

const MAX_U256 = (1n << 256n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const clampSlip = (s: any) => Math.max(0, Math.min(90, Number(s ?? 10)));

// Gas bands from robinhoodcode.py. `gas` is only the fallback when estimation
// reverts; signAndSend estimates per-tx with a 1.5x buffer and clamps to these.
// V4 gets the wider band because pool hooks execute arbitrary code.
const GAS_V4 = { gas: "900000", gasMin: "300000", gasMax: "1500000" } as const;
const GAS_V4_MULTIHOP = { gas: "1200000", gasMin: "300000", gasMax: "1500000" } as const;
const GAS_V4_SINGLE = { gas: "700000", gasMin: "300000", gasMax: "1500000" } as const;
const GAS_STD = { gas: "700000", gasMin: "200000", gasMax: "1000000" } as const;
// Multi-hop can cross three pools, each of which may run hook code, so the
// ceiling is higher than a single-hop V4 swap's.
const GAS_MULTIHOP = { gas: "1400000", gasMin: "400000", gasMax: "2500000" } as const;
// Bonding curves are plain contracts, but creator-tax logic runs on transfer.
const GAS_CURVE = { gas: "700000", gasMin: "300000", gasMax: "1500000" } as const;
const num = (x: any): number | null => {
  const n = Number(x);
  return isFinite(n) && x != null && x !== "" ? n : null;
};
const minWithSlip = (exp: bigint | null, slip: number): bigint => {
  if (!exp) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slip * 100))));
  return (exp * (10_000n - bps)) / 10_000n;
};

// ── approvals ────────────────────────────────────────────────────────────────
async function erc20Approvals(from: Address, token: Address, spender: Address, amountMin: bigint, cfg: ChainCfg = CHAINS.robinhood): Promise<UnsignedTx[]> {
  const cur = (await clientFor(cfg.key).readContract({ address: token, abi: dx.ERC20_APPROVE_ABI, functionName: "allowance", args: [from, spender] })) as bigint;
  if (cur >= amountMin) return [];
  return [{ to: token, data: encodeFunctionData({ abi: dx.ERC20_APPROVE_ABI, functionName: "approve", args: [spender, MAX_U256] }) }];
}

async function permit2Approvals(from: Address, token: Address, amountMin: bigint, cfg: ChainCfg = CHAINS.robinhood): Promise<UnsignedTx[]> {
  const txs: UnsignedTx[] = [];
  const client = clientFor(cfg.key);
  const ercAllow = (await client.readContract({ address: token, abi: dx.ERC20_APPROVE_ABI, functionName: "allowance", args: [from, cfg.permit2] })) as bigint;
  if (ercAllow < amountMin)
    txs.push({ to: token, data: encodeFunctionData({ abi: dx.ERC20_APPROVE_ABI, functionName: "approve", args: [cfg.permit2, MAX_U256] }) });

  const [amt, exp] = (await client.readContract({ address: cfg.permit2, abi: dx.PERMIT2_ABI, functionName: "allowance", args: [from, token, cfg.universalRouter] })) as any as [bigint, number];
  const now = Math.floor(Date.now() / 1000);
  if (amt < amountMin || Number(exp) < now + 60) {
    const newExp = now + 30 * 24 * 3600; // uint48 → viem expects number
    txs.push({ to: cfg.permit2, data: encodeFunctionData({ abi: dx.PERMIT2_ABI, functionName: "approve", args: [token, cfg.universalRouter, MAX_U160, newExp] }) });
  }
  return txs;
}

async function sellAmount(from: Address, token: Address, pct: number, cfg: ChainCfg = CHAINS.robinhood): Promise<bigint> {
  const bal = (await clientFor(cfg.key).readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [from] })) as bigint;
  if (bal <= 0n) throw new Error("No balance to sell.");
  // Clamp and integerise before BigInt(): a fractional percent throws
  // RangeError, and a negative one would silently produce a negative amount.
  const p = Math.max(1, Math.min(100, Math.floor(Number(pct) || 0)));
  const amt = p >= 100 ? bal : (bal * BigInt(p)) / 100n;
  if (amt <= 0n) throw new Error("Sell amount rounds to zero, try a larger %.");
  return amt;
}

// ── generic token BUY (V4 -> V3 -> V2) ───────────────────────────────────────
async function buildBuy(p: { ca: string; amountEth: string; address: string; slippage?: number; chain?: ChainKey }): Promise<TxBundle> {
  const cfg = cfgFor(p.chain);
  const tkn = getAddress(p.ca);
  const from = getAddress(p.address);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);

  // Robinhood routes by where the liquidity actually is, not by which venue
  // happens to answer first. See rhroute.ts for why the generic V4→V3→V2 order
  // is wrong on this chain.
  if (cfg.key === "robinhood") {
    if (tkn.toLowerCase() === USDG.toLowerCase())
      return buildUsdgBuy({ amountEth: p.amountEth, address: p.address, slippage: p.slippage });

    const route = await rh.bestPool(tkn);

    if (route?.version === "curve")
      return buildCurveBuy({ ca: p.ca, amountEth: p.amountEth, address: p.address, slippage: p.slippage, info: route.pons });

    if (route?.version === "multihop") {
      const buyPath = rh.reversePath(tkn, route.path);
      const quoted = await rh.quoteMultihop(WETH, buyPath, amt);
      await rhBuyGuard(route, tkn, amt, async () => quoted);
      // Exit proved on the same path, reversed — the route we would actually sell through.
      const err = await dx.evmBuyImpactError(tkn, amt, quoted, cfg, (t) => rh.quoteMultihop(tkn, route.path, t));
      if (err) throw new Error(err);
      return buildMultihopBuy({ ca: p.ca, amountEth: p.amountEth, address: p.address, slippage: p.slippage, path: route.path });
    }

    if (route?.version === "v4" && route.base === "usdg") {
      const leg = { fee: route.fee, tickSpacing: route.tickSpacing, hooks: route.hooks };
      const quoted = await stockQuoteBuy(tkn, amt, leg);
      await rhBuyGuard(route, tkn, amt, async () => quoted);
      const err = await dx.evmBuyImpactError(tkn, amt, quoted, cfg, (t) => stockQuoteSell(tkn, t, leg));
      if (err) throw new Error(err);
      return buildStockBuy({ stock: p.ca, amountEth: p.amountEth, address: p.address, slippage: p.slippage, leg });
    }

    if (route?.version === "v4" && route.base === "native") {
      const pk = route.poolKey;
      const usesWeth = dx.poolUsesWeth(pk, cfg);
      const currencyIn = usesWeth ? cfg.weth : dx.ZERO;
      const zeroForOne = pk.currency0.toLowerCase() === currencyIn.toLowerCase();
      const quoted = await dx.v4QuoteSingle(pk, zeroForOne, amt, cfg);
      await rhBuyGuard(route, tkn, amt, async () => quoted);
      const err = await dx.evmBuyImpactError(tkn, amt, quoted, cfg,
        (t) => dx.v4QuoteSingle(pk, !zeroForOne, t, cfg));
      if (err) throw new Error(err);
      const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne, amountIn: amt, amountOutMin: dx.applySlip(quoted, slip), currencyIn, currencyOut: tkn, payerIsUser: !usesWeth });
      const [commands, inputs] = usesWeth
        ? [dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2), [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input]]
        : [dx.CMD_V4_SWAP, [v4input]];
      const data = dx.urExecute(commands as any, inputs, dx.deadline());
      return { txs: [{ to: cfg.universalRouter, data, value: amt.toString(), ...GAS_V4 }], venue: "v4", chain: cfg.key, expectedOut: (quoted || 0n).toString() };
    }

    // A listed stock whose routing came back empty still has its USDG pool.
    if (!route && isStock(tkn))
      return buildStockBuy({ stock: p.ca, amountEth: p.amountEth, address: p.address, slippage: p.slippage });

    // Deepest pool is a V2/V3 WETH pool (or routing found nothing) — fall
    // through to the generic machinery below, but skip V4 detection so it
    // cannot grab a shallower pool than the one we just ranked.
    if (route?.version === "v2" || route?.version === "v3")
      return buildEvmBuyFallback(tkn, from, amt, slip, cfg, route.version === "v2", route.version === "v3");
    return buildEvmBuyFallback(tkn, from, amt, slip, cfg, false);
  }

  await assertPoolDeepEnough(tkn, amt, cfg);

  const v4 = await dx.v4Detect(tkn, cfg);
  if (v4) {
    const pk = v4.poolKey;
    const usesWeth = dx.poolUsesWeth(pk, cfg);
    const currencyIn = usesWeth ? cfg.weth : dx.ZERO;
    const zeroForOne = pk.currency0.toLowerCase() === currencyIn.toLowerCase();
    const quoted = await dx.v4QuoteSingle(pk, zeroForOne, amt, cfg);
    const err = await dx.evmBuyImpactError(tkn, amt, quoted, cfg);
    if (err) throw new Error(err);
    const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne, amountIn: amt, amountOutMin: dx.applySlip(quoted, slip), currencyIn, currencyOut: tkn, payerIsUser: !usesWeth });
    const [commands, inputs] = usesWeth
      ? [dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2), [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input]]
      : [dx.CMD_V4_SWAP, [v4input]];
    const data = dx.urExecute(commands as any, inputs, dx.deadline());
    return { txs: [{ to: cfg.universalRouter, data, value: amt.toString(), ...GAS_V4 }], venue: "v4", chain: cfg.key };
  }

  return buildEvmBuyFallback(tkn, from, amt, slip, cfg, false);
}

/**
 * V3 then V2, the venues that need no pool key.
 *
 * `forceV2` skips V3 entirely — used when Robinhood's depth ranking already
 * established that the deepest pool is a V2 one, so probing V3 fee tiers would
 * only find something shallower.
 */
async function buildEvmBuyFallback(tkn: Address, from: Address, amt: bigint, slip: number, cfg: ChainCfg, forceV2: boolean, preferV3 = false): Promise<TxBundle> {
  if (!forceV2) {
    const v3 = await dx.v3Detect(tkn, cfg, preferV3);
    if (v3) {
      const quoted = await dx.v3BuyQuote(tkn, v3.fee, amt, cfg);
      const err = await dx.evmBuyImpactError(tkn, amt, quoted, cfg,
        (t) => dx.v3SellQuote(tkn, v3.fee, t, cfg));
      if (err) throw new Error(err);
      const data = dx.v3ExactInputSingleData({ tokenIn: cfg.weth, tokenOut: tkn, fee: v3.fee, recipient: from, amountIn: amt, amountOutMinimum: dx.applySlip(quoted, slip) });
      return { txs: [{ to: cfg.v3Router, data, value: amt.toString(), ...GAS_STD }], venue: "v3", chain: cfg.key, expectedOut: (quoted || 0n).toString() };
    }
  }
  const quotedV2 = await dx.v2BuyQuote(tkn, amt, cfg);
  const errV2 = await dx.evmBuyImpactError(tkn, amt, quotedV2, cfg,
    (t) => dx.v2SellQuote(tkn, t, cfg));
  if (errV2) throw new Error(errV2);
  const data = dx.v2BuyData(dx.applySlip(quotedV2, slip), [cfg.weth, tkn], from);
  return { txs: [{ to: cfg.v2Router, data, value: amt.toString(), ...GAS_STD }], venue: "v2", chain: cfg.key, expectedOut: (quotedV2 || 0n).toString() };
}

/**
 * Depth floor for Ethereum and Base.
 *
 * Robinhood gets this through its route ranker, which knows each pool's USD
 * liquidity. The other chains route by venue detection and had no equivalent,
 * so a buy into a $40 pool was refused only if the round trip happened to look
 * bad. Size against depth is a separate failure and deserves its own check.
 */
async function assertPoolDeepEnough(token: Address, amtWei: bigint, cfg: ChainCfg): Promise<void> {
  const pair = await dx.bestPair(token, cfg).catch(() => null);
  const liq = Number(pair?.liquidity?.usd) || 0;
  if (!liq) return;                       // unknown depth is handled by the exit proof
  const ethUsd = (await nativePrice().catch(() => null))?.usd;
  if (!ethUsd) return;
  const block = rh.liquidityBlock({ version: "v2", liqUsd: liq, priceUsd: null, fairPriceUsd: null }, (Number(amtWei) / 1e18) * ethUsd);
  if (block) throw new Error(block);
}

/**
 * Reject a Robinhood buy that would fill far worse than the token is worth.
 *
 * The slippage floor on the swap only protects against the price moving between
 * quote and fill. It cannot tell that the pool being quoted is itself the wrong
 * pool. This compares the route's own quote against the token's true market
 * price — taken from the deepest pair anywhere, including pairs we cannot route
 * through — and refuses the trade if the gap is severe.
 */
async function rhBuyGuard(route: rh.RhRoute, token: Address, amtWei: bigint, quote: () => Promise<bigint | null>): Promise<void> {
  const ethUsd = (await nativePrice().catch(() => null))?.usd;
  // Size versus depth first: it needs no market price, so it still protects a
  // token DexScreener cannot price.
  if (ethUsd) {
    const block = rh.liquidityBlock(route, (Number(amtWei) / 1e18) * ethUsd);
    if (block) throw new Error(block);
  }
  const priceUsd = rh.routeFairPrice(route);
  if (!priceUsd || !ethUsd) return;
  const out = await quote();
  const decimals = await tokenDecimals(token, CHAINS.robinhood);
  const actual = out == null ? null : Number(out) / 10 ** decimals;
  const expected = (Number(amtWei) / 1e18) * ethUsd / priceUsd;
  const err = rh.impactError(expected, actual, "buy");
  if (err) throw new Error(err);
}

const decimalsCache = new Map<string, number>();
async function tokenDecimals(token: Address, cfg: ChainCfg): Promise<number> {
  const key = cfg.key + ":" + token.toLowerCase();
  const hit = decimalsCache.get(key);
  if (hit != null) return hit;
  let d = 18;
  try {
    d = Number(await clientFor(cfg.key).readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }));
  } catch { d = 18; }
  decimalsCache.set(key, d);
  return d;
}

/**
 * Refuse to build a swap we could not price.
 *
 * applySlip and the amountOutMin helpers all return 0n when the quoter does not
 * answer, and an order with amountOutMin = 0 accepts ANY output, including
 * effectively nothing. Buys were already protected because the price-impact
 * guard rejects a null quote, but sells were not: one RPC hiccup while exiting
 * a position and a sandwich could take almost the whole trade. Slippage that
 * cannot be computed is not slippage of zero, it is unknown, and unknown is a
 * reason to stop.
 */
function requireQuote(q: bigint | null): void {
  requireQuoteFor(q, "sell");
}

function requireQuoteFor(q: bigint | null, side: "buy" | "sell"): void {
  if (q == null || q <= 0n) {
    throw new Error(
      `Couldn't get a price for this ${side} right now, so it was not sent. ` +
      `Trading without a price check risks losing most of the trade. Try again in a moment.`,
    );
  }
}

// ── generic token SELL ───────────────────────────────────────────────────────
async function buildSell(p: { ca: string; pct: number; address: string; slippage?: number; chain?: ChainKey }): Promise<TxBundle> {
  const cfg = cfgFor(p.chain);
  const tkn = getAddress(p.ca);
  const from = getAddress(p.address);
  const slip = clampSlip(p.slippage);

  // Same depth-first routing as the buy side. A sell into the wrong pool is
  // the more expensive mistake of the two: a buy that fills badly can be held,
  // a sell that fills badly is realised immediately.
  if (cfg.key === "robinhood") {
    if (tkn.toLowerCase() === USDG.toLowerCase())
      return buildUsdgSell({ pct: p.pct, address: p.address, slippage: p.slippage });

    const route = await rh.bestPool(tkn);

    if (route?.version === "curve")
      return buildCurveSell({ ca: p.ca, pct: p.pct, address: p.address, slippage: p.slippage, info: route.pons });

    if (route?.version === "multihop") {
      await rhSellGuard(route, tkn, from, p.pct, (a) => rh.quoteMultihop(tkn, route.path, a));
      return buildMultihopSell({ ca: p.ca, pct: p.pct, address: p.address, slippage: p.slippage, path: route.path });
    }

    if (route?.version === "v4" && route.base === "usdg") {
      const leg = { fee: route.fee, tickSpacing: route.tickSpacing, hooks: route.hooks };
      await rhSellGuard(route, tkn, from, p.pct, (a) => stockQuoteSell(tkn, a, leg));
      return buildStockSell({ stock: p.ca, pct: p.pct, address: p.address, slippage: p.slippage, leg });
    }

    if (route?.version === "v4" && route.base === "native") {
      const pk = route.poolKey;
      const amt = await sellAmount(from, tkn, p.pct, cfg);
      const usesWeth = dx.poolUsesWeth(pk, cfg);
      const zeroForOne = pk.currency0.toLowerCase() === tkn.toLowerCase();
      const currencyOut = usesWeth ? cfg.weth : dx.ZERO;
      await rhSellGuard(route, tkn, from, p.pct, (a) => dx.v4QuoteSingle(pk, zeroForOne, a, cfg));
      const quotedSell = await dx.v4QuoteSingle(pk, zeroForOne, amt, cfg);
      requireQuote(quotedSell);
      const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne, amountIn: amt, amountOutMin: dx.applySlip(quotedSell, slip), currencyIn: tkn, currencyOut, takeRecipient: usesWeth ? dx.UR_ADDR_THIS : null });
      const [commands, inputs] = usesWeth
        ? [dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2), [v4input, dx.encodeUnwrapWeth(dx.UR_ADDR_SENDER, 0n)]]
        : [dx.CMD_V4_SWAP, [v4input]];
      const data = dx.urExecute(commands as any, inputs, dx.deadline());
      const approvals = await permit2Approvals(from, tkn, amt, cfg);
      return { txs: [...approvals, { to: cfg.universalRouter, data, ...GAS_V4 }], venue: "v4", chain: cfg.key, expectedOut: (quotedSell || 0n).toString() };
    }

    if (!route && isStock(tkn))
      return buildStockSell({ stock: p.ca, pct: p.pct, address: p.address, slippage: p.slippage });

    return buildEvmSellFallback(tkn, from, p.pct, slip, cfg, route?.version === "v2", route?.version === "v3");
  }

  const amt = await sellAmount(from, tkn, p.pct, cfg);

  const v4 = await dx.v4Detect(tkn, cfg);
  if (v4) {
    const pk = v4.poolKey;
    const usesWeth = dx.poolUsesWeth(pk, cfg);
    const zeroForOne = pk.currency0.toLowerCase() === tkn.toLowerCase();
    const currencyOut = usesWeth ? cfg.weth : dx.ZERO;
    const quotedSell = await dx.v4QuoteSingle(pk, zeroForOne, amt, cfg);
    requireQuote(quotedSell);
    const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne, amountIn: amt, amountOutMin: dx.applySlip(quotedSell, slip), currencyIn: tkn, currencyOut, takeRecipient: usesWeth ? dx.UR_ADDR_THIS : null });
    const [commands, inputs] = usesWeth
      ? [dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2), [v4input, dx.encodeUnwrapWeth(dx.UR_ADDR_SENDER, 0n)]]
      : [dx.CMD_V4_SWAP, [v4input]];
    const data = dx.urExecute(commands as any, inputs, dx.deadline());
    const approvals = await permit2Approvals(from, tkn, amt, cfg);
    return { txs: [...approvals, { to: cfg.universalRouter, data, ...GAS_V4 }], venue: "v4", chain: cfg.key };
  }

  return buildEvmSellFallback(tkn, from, p.pct, slip, cfg, false);
}

/** V3 then V2 sell. `forceV2` mirrors buildEvmBuyFallback. */
async function buildEvmSellFallback(tkn: Address, from: Address, pct: number, slip: number, cfg: ChainCfg, forceV2: boolean, preferV3 = false): Promise<TxBundle> {
  const amt = await sellAmount(from, tkn, pct, cfg);
  if (!forceV2) {
    const v3 = await dx.v3Detect(tkn, cfg, preferV3);
    if (v3) {
      const minOut = await dx.v3AmountOutMin(tkn, cfg.weth, v3.fee, amt, slip, cfg);
      requireQuote(minOut || null);
      const swap = dx.v3ExactInputSingleData({ tokenIn: tkn, tokenOut: cfg.weth, fee: v3.fee, recipient: dx.UR_ADDR_THIS, amountIn: amt, amountOutMinimum: minOut });
      const unwrap = dx.v3UnwrapData(minOut, from);
      const data = dx.v3MulticallData([swap, unwrap]);
      const approvals = await erc20Approvals(from, tkn, cfg.v3Router, amt, cfg);
      return { txs: [...approvals, { to: cfg.v3Router, data, ...GAS_STD }], venue: "v3", chain: cfg.key };
    }
  }
  // No V2 pool at all is a real possibility on Robinhood, and broadcasting the
  // swap anyway just burns the user's gas on a guaranteed revert.
  const minOut = await dx.v2AmountOutMin(amt, [tkn, cfg.weth], slip, cfg);
  requireQuote(minOut || null);
  const data = dx.v2SellData(amt, minOut, [tkn, cfg.weth], from);
  const approvals = await erc20Approvals(from, tkn, cfg.v2Router, amt, cfg);
  return { txs: [...approvals, { to: cfg.v2Router, data, ...GAS_STD }], venue: "v2", chain: cfg.key };
}

/**
 * Reject a Robinhood sell that returns far less than the position is worth.
 *
 * This is the guard that stops a thin or fabricated pool from taking a whole
 * position for dust — the failure that motivated depth-ranked routing in the
 * first place.
 */
async function rhSellGuard(route: rh.RhRoute, token: Address, from: Address, pct: number, quote: (amt: bigint) => Promise<bigint | null>): Promise<void> {
  const priceUsd = rh.routeFairPrice(route);
  const ethUsd = (await nativePrice().catch(() => null))?.usd;
  let amt: bigint;
  try { amt = await sellAmount(from, token, pct, CHAINS.robinhood); } catch { return; }
  const out = await quote(amt);
  const decimals = await tokenDecimals(token, CHAINS.robinhood);
  // Size the exit against the pool using what it would actually return, so the
  // check works even when the token has no published price.
  if (ethUsd && out != null) {
    const block = rh.liquidityBlock(route, (Number(out) / 1e18) * ethUsd);
    if (block) throw new Error(block);
  }
  if (!priceUsd || !ethUsd) return;
  const expectedUsd = (Number(amt) / 10 ** decimals) * priceUsd;
  const actualUsd = out == null ? null : (Number(out) / 1e18) * ethUsd;
  const err = rh.impactError(expectedUsd, actualUsd, "sell");
  if (err) throw new Error(err);
}

// ── stock quotes (USDG multi-hop) ────────────────────────────────────────────
/**
 * The STOCK/USDG leg of a stock route.
 *
 * Defaults to the 0.3%/60 tier every listed stock uses, but the deepest-pool
 * router can hand over a different fee, tick spacing or hook when a token pairs
 * against USDG on a pool of its own. Encoding the wrong tier addresses a pool
 * that does not exist and the swap reverts, so the resolved key always wins.
 */
type UsdgLeg = { fee?: number; tickSpacing?: number; hooks?: Address };
const usdgLeg = (l?: UsdgLeg) => ({
  fee: l?.fee ?? dx.RH_STOCK_FEE,
  tickSpacing: l?.tickSpacing ?? dx.RH_STOCK_TS,
  hooks: l?.hooks ?? dx.ZERO,
});

async function stockQuoteBuy(stock: Address, amountWei: bigint, leg?: UsdgLeg): Promise<bigint | null> {
  const L = usdgLeg(leg);
  const path = [
    { intermediateCurrency: USDG, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO, hookData: "0x" },
    { intermediateCurrency: stock, fee: L.fee, tickSpacing: L.tickSpacing, hooks: L.hooks, hookData: "0x" },
  ];
  return dx.callQuoter(dx.V4_QUOTER, dx.V4_QUOTER_MULTI_ABI, "quoteExactInput", [{ exactCurrency: WETH, path, exactAmount: amountWei }]);
}
async function stockQuoteSell(stock: Address, rawAmount: bigint, leg?: UsdgLeg): Promise<bigint | null> {
  const L = usdgLeg(leg);
  const path = [
    { intermediateCurrency: USDG, fee: L.fee, tickSpacing: L.tickSpacing, hooks: L.hooks, hookData: "0x" },
    { intermediateCurrency: WETH, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO, hookData: "0x" },
  ];
  return dx.callQuoter(dx.V4_QUOTER, dx.V4_QUOTER_MULTI_ABI, "quoteExactInput", [{ exactCurrency: stock, path, exactAmount: rawAmount }]);
}
async function stockPrice(stock: Address): Promise<number | null> {
  const st = getAddress(stock);
  const usdgFirst = BigInt(USDG) < BigInt(st);
  const [c0, c1] = usdgFirst ? [USDG, st] : [st, USDG];
  const zeroForOne = c0.toLowerCase() === st.toLowerCase();
  const out = await dx.callQuoter(dx.V4_QUOTER, dx.V4_QUOTER_SINGLE_ABI, "quoteExactInputSingle", [
    { poolKey: { currency0: c0, currency1: c1, fee: dx.RH_STOCK_FEE, tickSpacing: dx.RH_STOCK_TS, hooks: dx.ZERO }, zeroForOne, exactAmount: 10n ** 16n, hookData: "0x" },
  ]);
  return out ? (Number(out) / 1e6) / 0.01 : null;
}

async function buildStockBuy(p: { stock: string; amountEth: string; address: string; slippage?: number; leg?: UsdgLeg }): Promise<TxBundle> {
  const st = getAddress(p.stock);
  const from = getAddress(p.address);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);
  const L = usdgLeg(p.leg);
  const exp = await stockQuoteBuy(st, amt, p.leg);
  const minOut = minWithSlip(exp, slip);
  const path = [
    { currency: USDG, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO },
    { currency: st, fee: L.fee, tickSpacing: L.tickSpacing, hooks: L.hooks },
  ];
  const v4input = dx.v4EncodeMultihopInput({ currencyIn: WETH, path, amountIn: amt, amountOutMin: minOut, currencyOut: st, takeRecipient: from, payerIsUser: false });
  const data = dx.urExecute((dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2)) as any, [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input], dx.deadline());
  return { txs: [{ to: dx.UNIVERSAL_ROUTER, data, value: amt.toString(), ...GAS_V4_MULTIHOP }], venue: "v4", expectedOut: (exp || 0n).toString() };
}

async function buildStockSell(p: { stock: string; pct: number; address: string; slippage?: number; leg?: UsdgLeg }): Promise<TxBundle> {
  const st = getAddress(p.stock);
  const from = getAddress(p.address);
  const slip = clampSlip(p.slippage);
  const L = usdgLeg(p.leg);
  const amt = await sellAmount(from, st, p.pct);
  const exp = await stockQuoteSell(st, amt, p.leg);
  requireQuote(exp);
  const minOut = minWithSlip(exp, slip);
  const path = [
    { currency: USDG, fee: L.fee, tickSpacing: L.tickSpacing, hooks: L.hooks },
    { currency: WETH, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO },
  ];
  const v4input = dx.v4EncodeMultihopInput({ currencyIn: st, path, amountIn: amt, amountOutMin: minOut, currencyOut: WETH, takeRecipient: dx.UR_ADDR_THIS, payerIsUser: true });
  const data = dx.urExecute((dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2)) as any, [v4input, dx.encodeUnwrapWeth(from, minOut)], dx.deadline());
  const approvals = await permit2Approvals(from, st, amt);
  return { txs: [...approvals, { to: dx.UNIVERSAL_ROUTER, data, ...GAS_V4_MULTIHOP }], venue: "v4", expectedOut: (exp || 0n).toString() };
}

// ── Robinhood launchpad: bonding-curve tokens ────────────────────────────────
// A launchpad token has no Uniswap pool until it graduates, so every pool route
// finds nothing (or a dust pair) and the trade fails. Pre-graduation it trades
// against its own curve contract instead.

/**
 * Buy a token that is still on its Pons bonding curve.
 *
 * Native curves are one transaction. An ERC-20-quoted curve (cbBTC, USDG, …)
 * takes three, because the user holds ETH and the curve only accepts its own
 * quote asset: buy that asset, approve the curve for it, then buy on the curve
 * with whatever actually arrived. StrixBot skips these curves entirely, which
 * leaves the token untradeable anywhere — it has no pool to fall back to.
 */
async function buildCurveBuy(p: { ca: string; amountEth: string; address: string; slippage?: number; info: pons.PonsInfo }): Promise<TxBundle> {
  const from = getAddress(p.address);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);
  const info = p.info;

  const block = await pons.curveTradeBlock(info, "buy", from);
  if (block) throw new Error(block);

  if (info.native) {
    const exp = await pons.quoteBuy(info, amt, from);
    const data = pons.buyData(amt, minWithSlip(exp, slip), from);
    return { txs: [{ to: info.curve, data, value: amt.toString(), ...GAS_CURVE }], venue: "curve", chain: "robinhood", expectedOut: (exp || 0n).toString() };
  }

  // ── ERC-20 quoted curve ────────────────────────────────────────────────────
  const quoteTkn = info.pairToken;
  const before = (await clientFor("robinhood").readContract({
    address: quoteTkn, abi: ERC20_ABI, functionName: "balanceOf", args: [from] })) as bigint;

  const hop = await buildBuy({ ca: quoteTkn, amountEth: p.amountEth, address: p.address, slippage: p.slippage, chain: "robinhood" });
  const approvals = await erc20Approvals(from, quoteTkn, info.curve, MAX_U256 / 2n, CHAINS.robinhood);

  // Only what this bundle bought may be spent. Reading the plain balance would
  // sweep a quote-asset position the user already held into the trade.
  const build = async (): Promise<UnsignedTx> => {
    const now = (await clientFor("robinhood").readContract({
      address: quoteTkn, abi: ERC20_ABI, functionName: "balanceOf", args: [from] })) as bigint;
    const got = now > before ? now - before : 0n;
    if (got <= 0n) throw new Error("The swap into this curve's quote token did not arrive, so the buy was not sent.");
    const exp = await pons.quoteBuy({ ...info, native: false }, got, from);
    requireQuoteFor(exp, "buy");
    return { to: info.curve, data: pons.buyData(got, minWithSlip(exp, slip), from), ...GAS_CURVE };
  };

  return {
    txs: [...hop.txs, ...approvals, { to: info.curve, ...GAS_CURVE, rebuild: build }],
    venue: "curve", chain: "robinhood",
  };
}

/**
 * Sell a Pons curve token back to ETH.
 *
 * The curve prices a sell by simulating sell(), which pulls the tokens with
 * transferFrom and therefore reverts until the approval has confirmed. So the
 * swap is built late, after its approval lands, with a real quote behind it
 * rather than an unpriced order that would accept any output.
 */
async function buildCurveSell(p: { ca: string; pct: number; address: string; slippage?: number; info: pons.PonsInfo }): Promise<TxBundle> {
  const from = getAddress(p.address);
  const tkn = getAddress(p.ca);
  const info = p.info;
  const slip = clampSlip(p.slippage);

  const block = await pons.curveTradeBlock(info, "sell", from);
  if (block) throw new Error(block);

  const amt = await sellAmount(from, tkn, p.pct, CHAINS.robinhood);
  const approvals = await erc20Approvals(from, tkn, info.curve, amt, CHAINS.robinhood);

  const sellTx = async (): Promise<UnsignedTx> => {
    const exp = await pons.quoteSell(info, amt, from);
    requireQuoteFor(exp, "sell");
    return { to: info.curve, data: pons.sellData(amt, minWithSlip(exp, slip), from), ...GAS_CURVE };
  };

  if (info.native) {
    const txs = approvals.length
      ? [...approvals, { to: info.curve, ...GAS_CURVE, rebuild: sellTx }]
      : [await sellTx()];
    return { txs, venue: "curve", chain: "robinhood" };
  }

  // ERC-20 quoted: the curve pays out its quote asset, so a second leg converts
  // that back to ETH. Its size is only known once the curve has paid, so it is
  // built last, from the balance that actually arrived.
  const quoteTkn = info.pairToken;
  const before = (await clientFor("robinhood").readContract({
    address: quoteTkn, abi: ERC20_ABI, functionName: "balanceOf", args: [from] })) as bigint;

  const exitTx = async (): Promise<UnsignedTx> => {
    const now = (await clientFor("robinhood").readContract({
      address: quoteTkn, abi: ERC20_ABI, functionName: "balanceOf", args: [from] })) as bigint;
    const got = now > before ? now - before : 0n;
    if (got <= 0n) throw new Error("The curve sell did not pay out, so the swap back to ETH was not sent.");
    // 100% of exactly what the curve just paid, and nothing the user held before.
    const pct = Number((got * 100n) / (now > 0n ? now : got));
    const exit = await buildSell({ ca: quoteTkn, pct: Math.max(1, Math.min(100, pct)), address: p.address, slippage: p.slippage, chain: "robinhood" });
    const last = exit.txs[exit.txs.length - 1];
    if (exit.txs.length > 1) throw new Error("Selling this curve's quote token needs an approval first. Sell it from the wallet screen once the curve payout lands.");
    return last;
  };

  return {
    txs: [...approvals, { to: info.curve, ...GAS_CURVE, rebuild: sellTx }, { to: quoteTkn, ...GAS_STD, rebuild: exitTx }],
    venue: "curve", chain: "robinhood",
  };
}

// ── Robinhood multi-hop: trade through the pool that actually has liquidity ───
// Many RH tokens' deepest pool pairs against another token (often a tokenized
// stock) rather than WETH or USDG. Routing them through a directly-reachable
// side-pool fills against almost no liquidity; the path below goes through the
// real one and out to ETH in a single atomic Universal Router call.

async function buildMultihopBuy(p: { ca: string; amountEth: string; address: string; slippage?: number; path: dx.PathKey[] }): Promise<TxBundle> {
  const from = getAddress(p.address);
  const tkn = getAddress(p.ca);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);
  const buyPath = rh.reversePath(tkn, p.path);
  const exp = await rh.quoteMultihop(WETH, buyPath, amt);
  const v4input = dx.v4EncodeMultihopInput({
    currencyIn: WETH, path: buyPath, amountIn: amt, amountOutMin: minWithSlip(exp, slip),
    currencyOut: tkn, takeRecipient: from, payerIsUser: false,
  });
  const data = dx.urExecute((dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2)) as any, [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input], dx.deadline());
  return { txs: [{ to: dx.UNIVERSAL_ROUTER, data, value: amt.toString(), ...GAS_MULTIHOP }], venue: "v4-multihop", chain: "robinhood", expectedOut: (exp || 0n).toString() };
}

async function buildMultihopSell(p: { ca: string; pct: number; address: string; slippage?: number; path: dx.PathKey[] }): Promise<TxBundle> {
  const from = getAddress(p.address);
  const tkn = getAddress(p.ca);
  const slip = clampSlip(p.slippage);
  const amt = await sellAmount(from, tkn, p.pct, CHAINS.robinhood);
  const exp = await rh.quoteMultihop(tkn, p.path, amt);
  requireQuote(exp);
  const v4input = dx.v4EncodeMultihopInput({
    currencyIn: tkn, path: p.path, amountIn: amt, amountOutMin: minWithSlip(exp, slip),
    currencyOut: WETH, takeRecipient: dx.UR_ADDR_THIS, payerIsUser: true,
  });
  // UNWRAP_WETH with a zero floor: the swap's own amountOutMinimum already
  // enforces slippage, and the unwrap only moves what the swap produced.
  const data = dx.urExecute((dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2)) as any, [v4input, dx.encodeUnwrapWeth(dx.UR_ADDR_SENDER, 0n)], dx.deadline());
  const approvals = await permit2Approvals(from, tkn, amt, CHAINS.robinhood);
  return { txs: [...approvals, { to: dx.UNIVERSAL_ROUTER, data, ...GAS_MULTIHOP }], venue: "v4-multihop", chain: "robinhood", expectedOut: (exp || 0n).toString() };
}

// ── ETH <-> USDG direct swap (single-hop V4 on the WETH/USDG bridge pool) ─────
function usdgPoolKey() {
  const usdgFirst = BigInt(USDG) < BigInt(WETH);
  const [currency0, currency1] = usdgFirst ? [USDG, WETH] : [WETH, USDG];
  return { currency0, currency1, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO };
}
async function quoteV4Single(pk: any, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  return dx.callQuoter(dx.V4_QUOTER, dx.V4_QUOTER_SINGLE_ABI, "quoteExactInputSingle", [
    { poolKey: pk, zeroForOne, exactAmount: amountIn, hookData: "0x" },
  ]);
}

async function buildUsdgBuy(p: { amountEth: string; address: string; slippage?: number }): Promise<TxBundle> {
  const from = getAddress(p.address);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);
  const pk = usdgPoolKey();
  const zfo = pk.currency0.toLowerCase() === WETH.toLowerCase();
  const exp = await quoteV4Single(pk, zfo, amt);
  const minOut = minWithSlip(exp, slip);
  const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne: zfo, amountIn: amt, amountOutMin: minOut, currencyIn: WETH, currencyOut: USDG, payerIsUser: false });
  const data = dx.urExecute((dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2)) as any, [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input], dx.deadline());
  return { txs: [{ to: dx.UNIVERSAL_ROUTER, data, value: amt.toString(), ...GAS_V4_SINGLE }], venue: "v4", expectedOut: (exp || 0n).toString() };
}

async function buildUsdgSell(p: { pct: number; address: string; slippage?: number }): Promise<TxBundle> {
  const from = getAddress(p.address);
  const slip = clampSlip(p.slippage);
  const amt = await sellAmount(from, USDG, p.pct);
  const pk = usdgPoolKey();
  const zfo = pk.currency0.toLowerCase() === USDG.toLowerCase();
  const exp = await quoteV4Single(pk, zfo, amt);
  const minOut = minWithSlip(exp, slip);
  const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne: zfo, amountIn: amt, amountOutMin: minOut, currencyIn: USDG, currencyOut: WETH, takeRecipient: dx.UR_ADDR_THIS });
  const data = dx.urExecute((dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2)) as any, [v4input, dx.encodeUnwrapWeth(from, minOut)], dx.deadline());
  const approvals = await permit2Approvals(from, USDG, amt);
  return { txs: [...approvals, { to: dx.UNIVERSAL_ROUTER, data, ...GAS_V4_SINGLE }], venue: "v4", expectedOut: (exp || 0n).toString() };
}

// ── reads ────────────────────────────────────────────────────────────────────
const stockLogo = (sym: string) => `https://assets.parqet.com/logos/symbol/${sym.toUpperCase()}?format=png&size=64`;

async function tokenInfo(ca: string, chain?: ChainKey): Promise<TokenInfo> {
  const cfg = cfgFor(chain);

  // Solana: no checksummed address, no on-chain decimals() call. Identity and
  // price come from DexScreener, decimals from the mint account.
  if (cfg.vm === "svm") {
    const pair = await dx.bestPair(ca, cfg);
    const base = pair?.baseToken || {};
    let decimals = 9;
    try { decimals = await sol.tokenSupplyDecimals(ca); } catch { /* keep default */ }
    return {
      address: ca as any,
      symbol: base.symbol || "TOKEN",
      name: base.name || "Token",
      decimals,
      priceUsd: pair ? Number(pair.priceUsd) || null : null,
      priceNative: pair ? Number(pair.priceNative) || null : null,
      mcap: pair ? Number(pair.marketCap) || null : null,
      liquidityUsd: pair ? Number(pair.liquidity?.usd) || null : null,
      priceChange24h: pair ? Number(pair.priceChange?.h24) ?? null : null,
      volume24h: pair ? Number(pair.volume?.h24) || null : null,
      venue: (pair?.dexId || "solana") as any,
      pairUrl: pair?.url || null,
      isStock: false,
      logo: pair?.info?.imageUrl || null,
    };
  }

  const tkn = getAddress(ca);

  // Stocks are resolved 100% on-chain (never DexScreener — its symbol search
  // returns memecoins named "AAPL"). Identity comes from the pinned stock list,
  // price from the on-chain USDG quoter, logo from the real ticker logo.
  if (cfg.key === "robinhood" && isStock(tkn)) {
    const meta = STOCK_BY_ADDR[tkn.toLowerCase()];
    const price = await stockPrice(tkn).catch(() => null);
    return {
      address: tkn, symbol: meta.symbol, name: meta.name, decimals: 18,
      priceUsd: price, priceNative: null, mcap: null, liquidityUsd: null,
      priceChange24h: null, volume24h: null, venue: "v4", pairUrl: null,
      isStock: true, logo: stockLogo(meta.symbol),
    };
  }

  const stock = false;
  const pair = await dx.bestPair(tkn, cfg);
  let decimals = 18;
  try { decimals = Number(await clientFor(cfg.key).readContract({ address: tkn, abi: ERC20_ABI, functionName: "decimals" })); } catch { /* default 18 */ }

  let venue: TokenInfo["venue"] = "unknown";
  if (dx.isV4Pool(pair)) venue = "v4"; else if (dx.isV3Pool(pair)) venue = "v3"; else if (pair) venue = "v2";

  if (!pair) {
    const meta = STOCK_BY_ADDR[tkn.toLowerCase()];
    return {
      address: tkn, symbol: meta?.symbol || "TOKEN", name: meta?.name || "Token", decimals,
      priceUsd: stock ? await stockPrice(tkn).catch(() => null) : null,
      priceNative: null, mcap: null, liquidityUsd: null, priceChange24h: null, volume24h: null,
      venue: stock ? "v4" : venue, pairUrl: null, isStock: stock, logo: null,
    };
  }
  const base = pair.baseToken || {};
  return {
    address: tkn, symbol: base.symbol || "TOKEN", name: base.name || "Token", decimals,
    priceUsd: num(pair.priceUsd), priceNative: num(pair.priceNative), mcap: num(pair.marketCap ?? pair.fdv),
    liquidityUsd: num(pair.liquidity?.usd), priceChange24h: num(pair.priceChange?.h24), volume24h: num(pair.volume?.h24),
    venue: stock ? "v4" : venue, pairUrl: pair.url || null, isStock: stock, logo: pair.info?.imageUrl || null,
  };
}

async function nativePrice(): Promise<{ usd: number }> {
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + WETH_MAINNET);
    const pairs = ((await r.json())?.pairs || []).filter((p: any) => p.chainId === "ethereum" && p.priceUsd);
    pairs.sort((a: any, b: any) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    return { usd: Number(pairs[0]?.priceUsd) || 0 };
  } catch {
    return { usd: 0 };
  }
}

async function stocks(): Promise<{ stocks: { symbol: string; name: string; address: string; priceUsd: number | null }[] }> {
  const list = await Promise.all(
    RH_STOCKS.map(async (s) => ({ symbol: s.symbol, name: s.name, address: s.address, priceUsd: await stockPrice(s.address).catch(() => null) })),
  );
  return { stocks: list };
}

async function quoteBuy(ca: string, amountEth: string): Promise<{ expectedOut: string; decimals: number; venue: string }> {
  const tkn = getAddress(ca);
  if (isStock(tkn)) {
    const out = await stockQuoteBuy(tkn, parseEther(String(amountEth)));
    return { expectedOut: (out || 0n).toString(), decimals: 18, venue: "v4" };
  }
  return { expectedOut: "0", decimals: 18, venue: "unknown" };
}

export const api = {
  health: async () => ({ ok: true, chain: 4663 }),
  nativePrice,
  tokenInfo,
  stocks,
  quoteBuy,
  buildBuy,
  buildSell,
  buildStockBuy,
  buildStockSell,
  buildUsdgBuy,
  buildUsdgSell,
};
