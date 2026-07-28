// Client-side port of the Robinhood trading engine (robinhoodcode.py).
// Everything runs in the extension: DexScreener for metadata/prices, viem for
// on-chain quotes + Uniswap V4/V3/V2 swap encoding. No backend API.

import {
  concatHex, encodeAbiParameters, encodeFunctionData, decodeFunctionResult,
  getAddress, parseEther, parseAbiItem, type Address, type Hex,
} from "viem";
import { publicClient, WETH, USDG } from "./chain";

// ── Robinhood Chain addresses (from robinhoodcode.py EVM_CHAINS["robinhood"]) ─
export const V2_ROUTER: Address = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba";
export const V3_ROUTER: Address = "0xCaf681a66D020601342297493863E78C959E5cb2";
export const V3_QUOTER: Address = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
export const UNIVERSAL_ROUTER: Address = "0x8876789976decbfcbbbe364623c63652db8c0904";
export const V4_POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const V4_QUOTER: Address = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const UR_ADDR_SENDER: Address = "0x0000000000000000000000000000000000000001";
export const UR_ADDR_THIS: Address = "0x0000000000000000000000000000000000000002";

// Stock (USDG) route fee tiers.
export const RH_BRIDGE_FEE = 500, RH_BRIDGE_TS = 10; // ETH/WETH <-> USDG
export const RH_STOCK_FEE = 3000, RH_STOCK_TS = 60; // USDG <-> STOCK
export const V3_FEE_TIERS = [500, 3000, 10000, 100];

// UR command bytes + V4 action bytes.
const CMD_WRAP_ETH = "0x0b", CMD_UNWRAP_WETH = "0x0c", CMD_V4_SWAP = "0x10";
const A_SWAP_SINGLE = 0x06, A_SWAP = 0x07, A_SETTLE = 0x0b, A_SETTLE_ALL = 0x0c, A_TAKE = 0x0e, A_TAKE_ALL = 0x0f;
const hexByte = (n: number) => ("0x" + n.toString(16).padStart(2, "0")) as Hex;

// ── ABIs ────────────────────────────────────────────────────────────────────
export const UR_ABI = [
  { name: "execute", type: "function", stateMutability: "payable",
    inputs: [{ name: "commands", type: "bytes" }, { name: "inputs", type: "bytes[]" }, { name: "deadline", type: "uint256" }],
    outputs: [] },
] as const;

export const V3_ROUTER_ABI = [
  { name: "exactInputSingle", type: "function", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }] },
  { name: "unwrapWETH9", type: "function", stateMutability: "payable",
    inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { name: "multicall", type: "function", stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
] as const;

export const V3_QUOTER_ABI = [
  { name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
      { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }] },
] as const;

export const V4_QUOTER_SINGLE_ABI = [
  { name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
      { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }] },
] as const;

export const V4_QUOTER_MULTI_ABI = [
  { name: "quoteExactInput", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "exactCurrency", type: "address" },
      { name: "path", type: "tuple[]", components: [
        { name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }, { name: "hookData", type: "bytes" }] },
      { name: "exactAmount", type: "uint128" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }] },
] as const;

export const V2_ROUTER_ABI = [
  { name: "swapExactETHForTokensSupportingFeeOnTransferTokens", type: "function", stateMutability: "payable",
    inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [] },
  { name: "swapExactTokensForETHSupportingFeeOnTransferTokens", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [] },
  { name: "getAmountsOut", type: "function", stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }], outputs: [{ name: "amounts", type: "uint256[]" }] },
] as const;

export const PERMIT2_ABI = [
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "spender", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }], outputs: [] },
] as const;

export const ERC20_APPROVE_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const V3_POOL_ABI = [
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

const INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type PathKey = { currency: Address; fee: number; tickSpacing: number; hooks: Address };

// ── low-level: read a quoter (nonpayable → eth_call + decode) ────────────────
async function callQuoter(to: Address, abi: any, functionName: string, args: any[]): Promise<bigint | null> {
  try {
    const data = encodeFunctionData({ abi, functionName, args });
    const res = await publicClient.call({ to, data });
    if (!res.data) return null;
    const decoded = decodeFunctionResult({ abi, functionName, data: res.data }) as any;
    const out = Array.isArray(decoded) ? decoded[0] : decoded;
    return BigInt(out);
  } catch {
    return null;
  }
}

// ── V4 encoders (byte-identical to robinhoodcode.py) ─────────────────────────
export function v4EncodeSwapInput(o: {
  poolKey: PoolKey; zeroForOne: boolean; amountIn: bigint; amountOutMin: bigint;
  currencyIn: Address; currencyOut: Address; takeRecipient?: Address | null; payerIsUser?: boolean;
}): Hex {
  const payerIsUser = o.payerIsUser ?? true;
  const useTake = o.takeRecipient != null;
  const actions = concatHex([hexByte(A_SWAP_SINGLE), hexByte(payerIsUser ? A_SETTLE_ALL : A_SETTLE), hexByte(useTake ? A_TAKE : A_TAKE_ALL)]);
  const p0 = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] },
      { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }] }],
    [[[o.poolKey.currency0, o.poolKey.currency1, o.poolKey.fee, o.poolKey.tickSpacing, o.poolKey.hooks], o.zeroForOne, o.amountIn, o.amountOutMin, "0x"]] as any,
  );
  const p1 = payerIsUser
    ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [o.currencyIn, o.amountIn])
    : encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [o.currencyIn, o.amountIn, false]);
  const p2 = useTake
    ? encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [o.currencyOut, o.takeRecipient!, 0n])
    : encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [o.currencyOut, o.amountOutMin]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [p0, p1, p2]]);
}

export function v4EncodeMultihopInput(o: {
  currencyIn: Address; path: PathKey[]; amountIn: bigint; amountOutMin: bigint;
  currencyOut: Address; takeRecipient: Address; payerIsUser: boolean;
}): Hex {
  const actions = concatHex([hexByte(A_SWAP), hexByte(o.payerIsUser ? A_SETTLE_ALL : A_SETTLE), hexByte(A_TAKE)]);
  const p0 = encodeAbiParameters(
    [{ type: "tuple", components: [
      { type: "address" },
      { type: "tuple[]", components: [{ type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "bytes" }] },
      { type: "bytes" }, { type: "uint128" }, { type: "uint128" }] }],
    [[o.currencyIn, o.path.map((p) => [p.currency, p.fee, p.tickSpacing, p.hooks, "0x"]), "0x", o.amountIn, o.amountOutMin]] as any,
  );
  const p1 = o.payerIsUser
    ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [o.currencyIn, o.amountIn])
    : encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [o.currencyIn, 0n, false]);
  const p2 = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [o.currencyOut, o.takeRecipient, 0n]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [p0, p1, p2]]);
}

const encodeWrapEth = (recipient: Address, amount: bigint) => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [recipient, amount]);
const encodeUnwrapWeth = (recipient: Address, amountMin: bigint) => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [recipient, amountMin]);

export const urExecute = (commands: Hex, inputs: Hex[], deadline: bigint) =>
  encodeFunctionData({ abi: UR_ABI, functionName: "execute", args: [commands, inputs, deadline] });
export const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
export const poolUsesWeth = (pk: PoolKey) =>
  pk.currency0.toLowerCase() === WETH.toLowerCase() || pk.currency1.toLowerCase() === WETH.toLowerCase();
export { encodeWrapEth, encodeUnwrapWeth, callQuoter };

// ── DexScreener metadata ─────────────────────────────────────────────────────
const DS = "https://api.dexscreener.com/latest/dex/tokens/";
const pairCache = new Map<string, { t: number; v: any }>();

export async function bestPair(token: string): Promise<any | null> {
  const key = token.toLowerCase();
  const hit = pairCache.get(key);
  if (hit && Date.now() - hit.t < 30_000) return hit.v;
  try {
    const r = await fetch(DS + token);
    if (!r.ok) return null;
    const pairs = ((await r.json())?.pairs || []).filter((p: any) => p.chainId === "robinhood");
    pairs.sort((a: any, b: any) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
    const best = pairs[0] || null;
    pairCache.set(key, { t: Date.now(), v: best });
    return best;
  } catch {
    return null;
  }
}

export const isV4Pool = (p: any) => {
  if (!p) return false;
  const dex = (p.dexId || "").toLowerCase();
  if (dex.includes("uniswap_v4") || dex.includes("uni-v4") || dex === "uniswapv4") return true;
  return (p.labels || []).some((l: string) => (l || "").toLowerCase().includes("v4"));
};
export const isV3Pool = (p: any) => {
  if (!p) return false;
  const labels = (p.labels || []).map((l: string) => (l || "").toLowerCase());
  if (labels.some((l: string) => l.includes("v4"))) return false;
  const dex = (p.dexId || "").toLowerCase();
  if (dex.includes("uniswap_v3") || dex.includes("uni-v3") || dex === "uniswapv3") return true;
  return labels.some((l: string) => l.includes("v3"));
};

// ── V4 PoolKey lookup via PoolManager Initialize logs ───────────────────────
const poolKeyCache = new Map<string, PoolKey>();

export async function fetchV4PoolKey(poolId: string): Promise<PoolKey | null> {
  const id = (poolId.startsWith("0x") ? poolId : "0x" + poolId).toLowerCase();
  if (poolKeyCache.has(id)) return poolKeyCache.get(id)!;
  const idHex = ("0x" + id.slice(2).padStart(64, "0")) as Hex;

  const decode = (log: any): PoolKey => ({
    currency0: getAddress(log.args.currency0),
    currency1: getAddress(log.args.currency1),
    fee: Number(log.args.fee),
    tickSpacing: Number(log.args.tickSpacing),
    hooks: getAddress(log.args.hooks),
  });

  // Fast path: one filtered getLogs over all history (poolId is indexed → cheap).
  try {
    const logs = await publicClient.getLogs({
      address: V4_POOL_MANAGER, event: INITIALIZE_EVENT,
      args: { id: idHex }, fromBlock: 0n, toBlock: "latest",
    });
    if (logs.length) { const pk = decode(logs[0]); poolKeyCache.set(id, pk); return pk; }
  } catch { /* range too large — fall back to chunked scan */ }

  // Fallback: scan backward from head in chunks until found (cap the work).
  try {
    const latest = await publicClient.getBlockNumber();
    const CHUNK = 100_000n;
    let end = latest;
    for (let i = 0; i < 40 && end > 0n; i++) {
      const start = end > CHUNK ? end - CHUNK : 0n;
      try {
        const logs = await publicClient.getLogs({
          address: V4_POOL_MANAGER, event: INITIALIZE_EVENT, args: { id: idHex }, fromBlock: start, toBlock: end,
        });
        if (logs.length) { const pk = decode(logs[0]); poolKeyCache.set(id, pk); return pk; }
      } catch { /* skip bad chunk */ }
      if (start === 0n) break;
      end = start - 1n;
    }
  } catch { /* ignore */ }
  return null;
}

export async function v4Detect(token: Address): Promise<{ poolKey: PoolKey; pair: any } | null> {
  const pair = await bestPair(token);
  if (!isV4Pool(pair)) return null;
  const poolId = pair.pairAddress || pair.poolId;
  if (!poolId) return null;
  const poolKey = await fetchV4PoolKey(poolId);
  return poolKey ? { poolKey, pair } : null;
}

// ── V3 detection + quotes ────────────────────────────────────────────────────
async function v3ProbeFee(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<number | null> {
  let bestFee: number | null = null, bestOut = 0n;
  for (const fee of V3_FEE_TIERS) {
    const out = await callQuoter(V3_QUOTER, V3_QUOTER_ABI, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]);
    if (out && out > bestOut) { bestOut = out; bestFee = fee; }
  }
  return bestFee;
}

export async function v3Detect(token: Address): Promise<{ fee: number } | null> {
  const pair = await bestPair(token);
  if (isV3Pool(pair)) {
    let fee: number | null = null;
    if (pair.pairAddress) {
      try {
        fee = Number(await publicClient.readContract({ address: getAddress(pair.pairAddress), abi: V3_POOL_ABI, functionName: "fee" }));
      } catch { fee = null; }
    }
    if (!fee) fee = await v3ProbeFee(WETH, token, parseEther("0.001"));
    if (fee) return { fee };
  }
  if (!isV4Pool(pair)) {
    const fee = await v3ProbeFee(WETH, token, parseEther("0.001"));
    if (fee) return { fee };
  }
  return null;
}

export async function v3AmountOutMin(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint, slippagePct: number): Promise<bigint> {
  if (!slippagePct || slippagePct <= 0) return 0n;
  const exp = await callQuoter(V3_QUOTER, V3_QUOTER_ABI, "quoteExactInputSingle", [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]);
  if (!exp) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippagePct * 100))));
  return (exp * (10_000n - bps)) / 10_000n;
}

export async function v2AmountOutMin(amountIn: bigint, path: Address[], slippagePct: number): Promise<bigint> {
  if (!slippagePct || slippagePct <= 0) return 0n;
  try {
    const amounts = (await publicClient.readContract({ address: V2_ROUTER, abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, path] })) as bigint[];
    const expected = amounts[amounts.length - 1];
    const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippagePct * 100))));
    return (expected * (10_000n - bps)) / 10_000n;
  } catch {
    return 0n;
  }
}

// ── V4 single-pool quote + slippage floor (was hardcoded amountOutMin=0n) ────
export async function v4QuoteSingle(poolKey: any, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  return callQuoter(V4_QUOTER, V4_QUOTER_SINGLE_ABI, "quoteExactInputSingle",
    [{ poolKey: { currency0: poolKey.currency0, currency1: poolKey.currency1, fee: poolKey.fee, tickSpacing: poolKey.tickSpacing, hooks: poolKey.hooks },
       zeroForOne, exactAmount: amountIn, hookData: "0x" }]);
}

export function applySlip(expected: bigint | null, slippagePct: number): bigint {
  if (!expected || !slippagePct || slippagePct <= 0) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippagePct * 100))));
  return (expected * (10_000n - bps)) / 10_000n;
}

// Native → token buy quotes (for the impact guard + amountOutMin).
export async function v3BuyQuote(token: Address, fee: number, amountIn: bigint): Promise<bigint | null> {
  return callQuoter(V3_QUOTER, V3_QUOTER_ABI, "quoteExactInputSingle", [{ tokenIn: WETH, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: 0n }]);
}
export async function v2BuyQuote(token: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    const amounts = (await publicClient.readContract({ address: V2_ROUTER, abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, [WETH, token]] })) as bigint[];
    return amounts[amounts.length - 1];
  } catch { return null; }
}

// ── round-trip price-impact guard ────────────────────────────────────────────
export const EVM_MAX_BUY_IMPACT_PCT = 60;

export async function quoteToNative(token: Address, amountIn: bigint): Promise<bigint | null> {
  try {
    const v4 = await v4Detect(token);
    if (v4) {
      const zeroForOne = v4.poolKey.currency0.toLowerCase() === token.toLowerCase();
      const out = await v4QuoteSingle(v4.poolKey, zeroForOne, amountIn);
      if (out) return out;
    }
  } catch {}
  try {
    const v3 = await v3Detect(token);
    if (v3) {
      const out = await callQuoter(V3_QUOTER, V3_QUOTER_ABI, "quoteExactInputSingle", [{ tokenIn: token, tokenOut: WETH, amountIn, fee: v3.fee, sqrtPriceLimitX96: 0n }]);
      if (out) return out;
    }
  } catch {}
  try {
    const amounts = (await publicClient.readContract({ address: V2_ROUTER, abi: V2_ROUTER_ABI, functionName: "getAmountsOut", args: [amountIn, [token, WETH]] })) as bigint[];
    return amounts[amounts.length - 1];
  } catch {}
  return null;
}

/** Returns an error string to BLOCK a buy that would round-trip back to
 *  < (100 - EVM_MAX_BUY_IMPACT_PCT)% of what was paid (thin/wrong pool,
 *  honeypot, extreme tax), or null to proceed. */
export async function evmBuyImpactError(token: Address, amountWei: bigint, tokensOut: bigint | null): Promise<string | null> {
  if (!tokensOut || tokensOut <= 0n) return "Couldn't price this buy - no tradeable liquidity found. Trade blocked to protect your funds.";
  const back = await quoteToNative(token, tokensOut);
  if (back === null || amountWei <= 0n) return null;
  const recoverPct = Number((back * 10_000n) / amountWei) / 100;
  if (recoverPct < (100 - EVM_MAX_BUY_IMPACT_PCT)) {
    return `Trade blocked - price impact too high. You'd get tokens worth only ~${recoverPct.toFixed(1)}% of what you paid (pool too thin or token restricted). Try a smaller size or a different token.`;
  }
  return null;
}

// ── V3 swap calldata builders ────────────────────────────────────────────────
export const v3ExactInputSingleData = (p: { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; amountOutMinimum: bigint }) =>
  encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: "exactInputSingle", args: [{ ...p, sqrtPriceLimitX96: 0n }] });
export const v3MulticallData = (calls: Hex[]) => encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: "multicall", args: [calls] });
export const v3UnwrapData = (amountMinimum: bigint, recipient: Address) =>
  encodeFunctionData({ abi: V3_ROUTER_ABI, functionName: "unwrapWETH9", args: [amountMinimum, recipient] });
export const v2BuyData = (amountOutMin: bigint, path: Address[], to: Address) =>
  encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [amountOutMin, path, to, deadline() + 400n] });
export const v2SellData = (amountIn: bigint, amountOutMin: bigint, path: Address[], to: Address) =>
  encodeFunctionData({ abi: V2_ROUTER_ABI, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amountIn, amountOutMin, path, to, deadline() + 400n] });

export { CMD_WRAP_ETH, CMD_UNWRAP_WETH, CMD_V4_SWAP };
