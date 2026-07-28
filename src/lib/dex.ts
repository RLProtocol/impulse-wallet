// HoodX Wallet trade engine — 100% client-side (no backend API).
// Exposes the same `api` interface the UI used before, but every call runs
// locally: DexScreener for metadata/prices, viem for on-chain quotes + swap
// building. Faithful port of robinhoodcode.py's routing + encoders.

import { encodeFunctionData, getAddress, parseEther, type Address } from "viem";
import { publicClient, WETH, USDG, ERC20_ABI, RH_STOCKS, STOCK_BY_ADDR, isStock } from "./chain";
import type { UnsignedTx } from "./wallet";
import type { TokenInfo, TxBundle } from "./api";
import * as dx from "./dexcore";

const MAX_U256 = (1n << 256n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const clampSlip = (s: any) => Math.max(0, Math.min(90, Number(s ?? 10)));
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
async function erc20Approvals(from: Address, token: Address, spender: Address, amountMin: bigint): Promise<UnsignedTx[]> {
  const cur = (await publicClient.readContract({ address: token, abi: dx.ERC20_APPROVE_ABI, functionName: "allowance", args: [from, spender] })) as bigint;
  if (cur >= amountMin) return [];
  return [{ to: token, data: encodeFunctionData({ abi: dx.ERC20_APPROVE_ABI, functionName: "approve", args: [spender, MAX_U256] }) }];
}

async function permit2Approvals(from: Address, token: Address, amountMin: bigint): Promise<UnsignedTx[]> {
  const txs: UnsignedTx[] = [];
  const ercAllow = (await publicClient.readContract({ address: token, abi: dx.ERC20_APPROVE_ABI, functionName: "allowance", args: [from, dx.PERMIT2] })) as bigint;
  if (ercAllow < amountMin)
    txs.push({ to: token, data: encodeFunctionData({ abi: dx.ERC20_APPROVE_ABI, functionName: "approve", args: [dx.PERMIT2, MAX_U256] }) });

  const [amt, exp] = (await publicClient.readContract({ address: dx.PERMIT2, abi: dx.PERMIT2_ABI, functionName: "allowance", args: [from, token, dx.UNIVERSAL_ROUTER] })) as any as [bigint, number];
  const now = Math.floor(Date.now() / 1000);
  if (amt < amountMin || Number(exp) < now + 60) {
    const newExp = now + 30 * 24 * 3600; // uint48 → viem expects number
    txs.push({ to: dx.PERMIT2, data: encodeFunctionData({ abi: dx.PERMIT2_ABI, functionName: "approve", args: [token, dx.UNIVERSAL_ROUTER, MAX_U160, newExp] }) });
  }
  return txs;
}

async function sellAmount(from: Address, token: Address, pct: number): Promise<bigint> {
  const bal = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [from] })) as bigint;
  if (bal <= 0n) throw new Error("No balance to sell.");
  const amt = pct >= 100 ? bal : (bal * BigInt(pct)) / 100n;
  if (amt <= 0n) throw new Error("Sell amount rounds to zero, try a larger %.");
  return amt;
}

// ── generic token BUY (V4 -> V3 -> V2) ───────────────────────────────────────
async function buildBuy(p: { ca: string; amountEth: string; address: string; slippage?: number }): Promise<TxBundle> {
  const tkn = getAddress(p.ca);
  // Stocks pair against USDG - route through the stock path, not the WETH router.
  if (isStock(tkn)) return buildStockBuy({ stock: p.ca, amountEth: p.amountEth, address: p.address, slippage: p.slippage });
  if (tkn.toLowerCase() === USDG.toLowerCase()) return buildUsdgBuy({ amountEth: p.amountEth, address: p.address, slippage: p.slippage });
  const from = getAddress(p.address);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);

  const v4 = await dx.v4Detect(tkn);
  if (v4) {
    const pk = v4.poolKey;
    const usesWeth = dx.poolUsesWeth(pk);
    const currencyIn = usesWeth ? WETH : dx.ZERO;
    const zeroForOne = pk.currency0.toLowerCase() === currencyIn.toLowerCase();
    const quoted = await dx.v4QuoteSingle(pk, zeroForOne, amt);
    const err = await dx.evmBuyImpactError(tkn, amt, quoted);
    if (err) throw new Error(err);
    const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne, amountIn: amt, amountOutMin: dx.applySlip(quoted, slip), currencyIn, currencyOut: tkn, payerIsUser: !usesWeth });
    const [commands, inputs] = usesWeth
      ? [dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2), [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input]]
      : [dx.CMD_V4_SWAP, [v4input]];
    const data = dx.urExecute(commands as any, inputs, dx.deadline());
    return { txs: [{ to: dx.UNIVERSAL_ROUTER, data, value: amt.toString(), gas: "900000" }], venue: "v4" };
  }

  const v3 = await dx.v3Detect(tkn);
  if (v3) {
    const quoted = await dx.v3BuyQuote(tkn, v3.fee, amt);
    const err = await dx.evmBuyImpactError(tkn, amt, quoted);
    if (err) throw new Error(err);
    const data = dx.v3ExactInputSingleData({ tokenIn: WETH, tokenOut: tkn, fee: v3.fee, recipient: from, amountIn: amt, amountOutMinimum: dx.applySlip(quoted, slip) });
    return { txs: [{ to: dx.V3_ROUTER, data, value: amt.toString(), gas: "700000" }], venue: "v3" };
  }

  const quotedV2 = await dx.v2BuyQuote(tkn, amt);
  const errV2 = await dx.evmBuyImpactError(tkn, amt, quotedV2);
  if (errV2) throw new Error(errV2);
  const data = dx.v2BuyData(dx.applySlip(quotedV2, slip), [WETH, tkn], from);
  return { txs: [{ to: dx.V2_ROUTER, data, value: amt.toString(), gas: "700000" }], venue: "v2" };
}

// ── generic token SELL ───────────────────────────────────────────────────────
async function buildSell(p: { ca: string; pct: number; address: string; slippage?: number }): Promise<TxBundle> {
  const tkn = getAddress(p.ca);
  if (isStock(tkn)) return buildStockSell({ stock: p.ca, pct: p.pct, address: p.address, slippage: p.slippage });
  const from = getAddress(p.address);
  const slip = clampSlip(p.slippage);
  const amt = await sellAmount(from, tkn, p.pct);

  const v4 = await dx.v4Detect(tkn);
  if (v4) {
    const pk = v4.poolKey;
    const usesWeth = dx.poolUsesWeth(pk);
    const zeroForOne = pk.currency0.toLowerCase() === tkn.toLowerCase();
    const currencyOut = usesWeth ? WETH : dx.ZERO;
    const quotedSell = await dx.v4QuoteSingle(pk, zeroForOne, amt);
    const v4input = dx.v4EncodeSwapInput({ poolKey: pk, zeroForOne, amountIn: amt, amountOutMin: dx.applySlip(quotedSell, slip), currencyIn: tkn, currencyOut, takeRecipient: usesWeth ? dx.UR_ADDR_THIS : null });
    const [commands, inputs] = usesWeth
      ? [dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2), [v4input, dx.encodeUnwrapWeth(dx.UR_ADDR_SENDER, 0n)]]
      : [dx.CMD_V4_SWAP, [v4input]];
    const data = dx.urExecute(commands as any, inputs, dx.deadline());
    const approvals = await permit2Approvals(from, tkn, amt);
    return { txs: [...approvals, { to: dx.UNIVERSAL_ROUTER, data, gas: "900000" }], venue: "v4" };
  }

  const v3 = await dx.v3Detect(tkn);
  if (v3) {
    const minOut = await dx.v3AmountOutMin(tkn, WETH, v3.fee, amt, slip);
    const swap = dx.v3ExactInputSingleData({ tokenIn: tkn, tokenOut: WETH, fee: v3.fee, recipient: dx.UR_ADDR_THIS, amountIn: amt, amountOutMinimum: minOut });
    const unwrap = dx.v3UnwrapData(minOut, from);
    const data = dx.v3MulticallData([swap, unwrap]);
    const approvals = await erc20Approvals(from, tkn, dx.V3_ROUTER, amt);
    return { txs: [...approvals, { to: dx.V3_ROUTER, data, gas: "700000" }], venue: "v3" };
  }

  const minOut = await dx.v2AmountOutMin(amt, [tkn, WETH], slip);
  const data = dx.v2SellData(amt, minOut, [tkn, WETH], from);
  const approvals = await erc20Approvals(from, tkn, dx.V2_ROUTER, amt);
  return { txs: [...approvals, { to: dx.V2_ROUTER, data, gas: "700000" }], venue: "v2" };
}

// ── stock quotes (USDG multi-hop) ────────────────────────────────────────────
async function stockQuoteBuy(stock: Address, amountWei: bigint): Promise<bigint | null> {
  const path = [
    { intermediateCurrency: USDG, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO, hookData: "0x" },
    { intermediateCurrency: stock, fee: dx.RH_STOCK_FEE, tickSpacing: dx.RH_STOCK_TS, hooks: dx.ZERO, hookData: "0x" },
  ];
  return dx.callQuoter(dx.V4_QUOTER, dx.V4_QUOTER_MULTI_ABI, "quoteExactInput", [{ exactCurrency: WETH, path, exactAmount: amountWei }]);
}
async function stockQuoteSell(stock: Address, rawAmount: bigint): Promise<bigint | null> {
  const path = [
    { intermediateCurrency: USDG, fee: dx.RH_STOCK_FEE, tickSpacing: dx.RH_STOCK_TS, hooks: dx.ZERO, hookData: "0x" },
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

async function buildStockBuy(p: { stock: string; amountEth: string; address: string; slippage?: number }): Promise<TxBundle> {
  const st = getAddress(p.stock);
  const from = getAddress(p.address);
  const amt = parseEther(String(p.amountEth));
  const slip = clampSlip(p.slippage);
  const exp = await stockQuoteBuy(st, amt);
  const minOut = minWithSlip(exp, slip);
  const path = [
    { currency: USDG, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO },
    { currency: st, fee: dx.RH_STOCK_FEE, tickSpacing: dx.RH_STOCK_TS, hooks: dx.ZERO },
  ];
  const v4input = dx.v4EncodeMultihopInput({ currencyIn: WETH, path, amountIn: amt, amountOutMin: minOut, currencyOut: st, takeRecipient: from, payerIsUser: false });
  const data = dx.urExecute((dx.CMD_WRAP_ETH + dx.CMD_V4_SWAP.slice(2)) as any, [dx.encodeWrapEth(dx.UR_ADDR_THIS, amt), v4input], dx.deadline());
  return { txs: [{ to: dx.UNIVERSAL_ROUTER, data, value: amt.toString(), gas: "1200000" }], venue: "v4", expectedOut: (exp || 0n).toString() };
}

async function buildStockSell(p: { stock: string; pct: number; address: string; slippage?: number }): Promise<TxBundle> {
  const st = getAddress(p.stock);
  const from = getAddress(p.address);
  const slip = clampSlip(p.slippage);
  const amt = await sellAmount(from, st, p.pct);
  const exp = await stockQuoteSell(st, amt);
  const minOut = minWithSlip(exp, slip);
  const path = [
    { currency: USDG, fee: dx.RH_STOCK_FEE, tickSpacing: dx.RH_STOCK_TS, hooks: dx.ZERO },
    { currency: WETH, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: dx.ZERO },
  ];
  const v4input = dx.v4EncodeMultihopInput({ currencyIn: st, path, amountIn: amt, amountOutMin: minOut, currencyOut: WETH, takeRecipient: dx.UR_ADDR_THIS, payerIsUser: true });
  const data = dx.urExecute((dx.CMD_V4_SWAP + dx.CMD_UNWRAP_WETH.slice(2)) as any, [v4input, dx.encodeUnwrapWeth(from, minOut)], dx.deadline());
  const approvals = await permit2Approvals(from, st, amt);
  return { txs: [...approvals, { to: dx.UNIVERSAL_ROUTER, data, gas: "1200000" }], venue: "v4", expectedOut: (exp || 0n).toString() };
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
  return { txs: [{ to: dx.UNIVERSAL_ROUTER, data, value: amt.toString(), gas: "700000" }], venue: "v4", expectedOut: (exp || 0n).toString() };
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
  return { txs: [...approvals, { to: dx.UNIVERSAL_ROUTER, data, gas: "700000" }], venue: "v4", expectedOut: (exp || 0n).toString() };
}

// ── reads ────────────────────────────────────────────────────────────────────
const stockLogo = (sym: string) => `https://assets.parqet.com/logos/symbol/${sym.toUpperCase()}?format=png&size=64`;

async function tokenInfo(ca: string): Promise<TokenInfo> {
  const tkn = getAddress(ca);

  // Stocks are resolved 100% on-chain (never DexScreener — its symbol search
  // returns memecoins named "AAPL"). Identity comes from the pinned stock list,
  // price from the on-chain USDG quoter, logo from the real ticker logo.
  if (isStock(tkn)) {
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
  const pair = await dx.bestPair(tkn);
  let decimals = 18;
  try { decimals = Number(await publicClient.readContract({ address: tkn, abi: ERC20_ABI, functionName: "decimals" })); } catch { /* default 18 */ }

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
