// Pons launchpad (Robinhood Chain) — bonding-curve tokens.
//
// A Pons launch holds its entire supply on a per-token bonding curve and only
// becomes a Uniswap V4 pool once the curve sells out. Before that there is NO
// pool, so DexScreener has nothing to index and every pool-based route finds
// nothing. That is the whole reason these tokens could not be traded here.
//
// Written against docs.ponsfamily.com/v2, with every function below confirmed
// live on-chain rather than assumed:
//
//   • Quote assets are native ETH or a protocol-approved ERC-20. A cbBTC-paired
//     curve charges in cbBTC, an 8-decimal token — so nothing here may assume
//     18 decimals on the quote side.
//   • getReserves() includes a PHANTOM quote reserve that sets the opening
//     price. realQuoteReserve() is what was actually paid in and is near zero
//     on a fresh launch; pricing off it would be wildly wrong.
//   • A snipe tax starts at 99% of a buy and decays to zero over the first five
//     seconds. Buying into it is an instant near-total loss, so it is checked
//     and refused rather than left to the user to notice.
//   • Buys clamp to sellableTokens() and refund the excess; sells REVERT once
//     readyToGraduate() is true.

import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { CHAINS, clientFor } from "./chains";

const RH = CHAINS.robinhood;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Shared hook on every graduated Pons V4 pool. The pool's own fee is 0; the
 *  hook charges instead, which is why a graduated pool key uses fee = 0. */
export const PONS_MEME_HOOK: Address = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

const FACTORY_ABI = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function approvedPairTokens(address) view returns (bool)",
]);

// buy/sell keep the (uint256,uint256,address) shape the selectors are built
// from; the parameter names follow the published spec.
export const CURVE_ABI = parseAbi([
  "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256 quoteOut)",
  "function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)",
  "function sellableTokens() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
  "function isNativeQuote() view returns (bool)",
  "function pairToken() view returns (address)",
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function currentSnipeTaxBps(address recipient) view returns (uint256)",
]);

const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);

/** 0 = on the curve, 1 = curve drained but pool not created yet, 2 = trading on
 *  V4, 3 = recovered. Phase 1 is a genuine dead zone: neither venue works. */
export type Phase = 0 | 1 | 2 | 3;

export type PonsInfo = {
  token: Address;
  curve: Address;
  phase: Phase;
  /** True only in phase 0 — the curve is the venue. */
  onCurve: boolean;
  native: boolean;
  /** Quote asset the curve charges in. ZERO when native. */
  pairToken: Address;
  pairDecimals: number;
  /** Protocol fee, in basis points of the quote leg. */
  feeBps: number;
  /** Creator tax, in basis points. Fixed at launch, capped, never raised. */
  creatorTaxBps: number;
  /** Includes the phantom reserve — this is the pricing reserve. */
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellableTokens: bigint;
  graduationThreshold: bigint;
  readyToGraduate: boolean;
  /** Pool tick spacing recorded at launch, used to rebuild the graduated key. */
  tickSpacing: number;
  /** 0..1 toward graduation, from the real quote taken in. */
  progress: number;
};

// Phase flips mid-trade at graduation and the two sides use entirely different
// contracts, so this cache is deliberately short-lived.
const cache = new Map<string, { t: number; v: PonsInfo | null }>();
const TTL = 30_000;

/**
 * Everything needed to trade a Pons token, or null if it is not one.
 *
 * Deliberately returns info for every phase rather than only phase 0: the
 * caller has to be able to tell "on a curve" from "graduated to a pool" from
 * "in the gap between the two", and only the last of those is untradeable.
 */
export async function ponsInfo(token: Address): Promise<PonsInfo | null> {
  const factory = RH.launchpadFactory;
  if (!factory) return null;
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  let out: PonsInfo | null = null;
  try {
    const client = clientFor("robinhood");
    const rec = (await client.readContract({
      address: factory, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token],
    })) as any;
    if (!rec.exists || BigInt(rec.curve) === 0n) {
      cache.set(key, { t: Date.now(), v: null });
      return null;
    }
    const curve = getAddress(rec.curve);
    const phase = Math.min(3, Math.max(0, Number(rec.phase))) as Phase;

    // The curve is authoritative about its own quote asset — the factory record
    // stores it too, but the curve is what the swap will actually enforce.
    const [reserves, sellable, ready, thr, native, pair, feeBps, taxBps] = await Promise.all([
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "getReserves" }).catch(() => [0n, 0n]),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "sellableTokens" }).catch(() => 0n),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "readyToGraduate" }).catch(() => false),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "graduationThreshold" }).catch(() => 0n),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "isNativeQuote" }).catch(() => true),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "pairToken" }).catch(() => ZERO),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "feeBps" }).catch(() => 0n),
      client.readContract({ address: curve, abi: CURVE_ABI, functionName: "creatorTaxBps" }).catch(() => 0n),
    ]);

    const [quoteReserve, tokenReserve] = reserves as [bigint, bigint];
    const isNative = Boolean(native);
    const pairToken = isNative ? ZERO : getAddress(pair as string);

    let pairDecimals = 18;
    if (!isNative) {
      try {
        pairDecimals = Number(await client.readContract({
          address: pairToken, abi: DECIMALS_ABI, functionName: "decimals" }));
      } catch { pairDecimals = 18; }
    }

    const threshold = BigInt(thr as bigint);
    out = {
      token, curve, phase, onCurve: phase === 0,
      native: isNative, pairToken, pairDecimals,
      feeBps: Number(feeBps), creatorTaxBps: Number(taxBps),
      quoteReserve, tokenReserve,
      sellableTokens: BigInt(sellable as bigint),
      graduationThreshold: threshold,
      readyToGraduate: Boolean(ready),
      tickSpacing: Number(rec.tickSpacing),
      progress: threshold > 0n ? Math.min(1, Number(quoteReserve) / Number(threshold)) : 0,
    };
  } catch { out = null; }

  cache.set(key, { t: Date.now(), v: out });
  return out;
}

/** Is this ERC-20 an approved Pons quote asset? Native is handled separately
 *  and is NOT in the registry, so never gate a native launch on this. */
export async function isApprovedPairToken(token: Address): Promise<boolean> {
  const factory = RH.launchpadFactory;
  if (!factory) return false;
  try {
    return Boolean(await clientFor("robinhood").readContract({
      address: factory, abi: FACTORY_ABI, functionName: "approvedPairTokens", args: [token] }));
  } catch { return false; }
}

/**
 * The snipe tax this recipient would pay right now, in basis points.
 *
 * 9900 at launch, decaying to 0 across five seconds. The launcher and creator
 * fee recipient are exempt. Anyone else buying inside that window pays it out
 * of their input, so it has to be read per-recipient, not per-token.
 */
export async function snipeTaxBps(curve: Address, recipient: Address): Promise<number> {
  try {
    return Number(await clientFor("robinhood").readContract({
      address: curve, abi: CURVE_ABI, functionName: "currentSnipeTaxBps", args: [recipient] }));
  } catch { return 0; }
}

/** Highest snipe tax we will let a buy through at: 1%. */
const MAX_SNIPE_BPS = 100;

/**
 * Highest combined fee a curve may charge before a buy is refused: 25%.
 *
 * A curve cannot be round-trip tested the way a pool can — sell() pulls the
 * tokens with transferFrom, so it will not simulate until the user already
 * holds them. But a curve does not need testing the same way: it is symmetric
 * constant-product with its fees published on-chain, so the round trip is
 * arithmetic. Buying and immediately selling returns about (1 - fee)², which
 * at 25% total fees is 56% back. Beyond that the fee itself is the loss, and
 * no amount of care about the pool would save the user from it.
 */
const MAX_CURVE_FEE_BPS = 2_500;

/**
 * Why this trade cannot be made, or null if it can.
 *
 * These are the conditions that lose money outright rather than merely costing
 * more than expected, so they stop the trade instead of warning about it.
 */
export async function curveTradeBlock(info: PonsInfo, side: "buy" | "sell", recipient: Address): Promise<string | null> {
  if (info.phase === 1)
    return "This token has just sold out its bonding curve and its Uniswap pool is still being created. Trading opens again in a moment.";
  if (!info.onCurve) return null;

  if (side === "sell" && info.readyToGraduate)
    return "This token has finished its bonding curve and is graduating to a Uniswap pool. Selling reopens once the pool exists.";

  if (side === "buy") {
    if (info.sellableTokens <= 0n)
      return "This bonding curve has sold out and is graduating to a Uniswap pool. Try again in a moment.";

    // The curve is symmetric, so its declared fees ARE the round-trip cost.
    const total = info.feeBps + info.creatorTaxBps;
    if (total > MAX_CURVE_FEE_BPS) {
      const retain = Math.round((1 - total / 10_000) ** 2 * 100);
      return `Buy blocked: this curve charges ${(total / 100).toFixed(1)}% in fees and creator tax on ` +
        `every trade. Buying and selling straight back would return about ${retain}% of your money, ` +
        `before the price moves at all.`;
    }
    const snipe = await snipeTaxBps(info.curve, recipient);
    if (snipe > MAX_SNIPE_BPS) {
      const pct = (snipe / 100).toFixed(snipe >= 1000 ? 0 : 1);
      return `This token launched seconds ago and its anti-snipe tax is still ${pct}% of your buy. It falls to zero within five seconds of launch, so wait a moment and you keep that ${pct}%.`;
    }
  }
  return null;
}

/**
 * Tokens out for spending `quoteIn` on the curve.
 *
 * Simulated rather than computed. The curve takes protocol fee, creator tax and
 * snipe tax off the input before pricing, and clamps to sellableTokens with a
 * refund — reproducing all of that off-chain would drift from the contract, and
 * a minTokensOut derived from a drifting model either reverts or under-protects.
 */
export async function quoteBuy(info: PonsInfo, quoteIn: bigint, from: Address): Promise<bigint | null> {
  try {
    const { result } = await clientFor("robinhood").simulateContract({
      address: info.curve, abi: CURVE_ABI, functionName: "buy",
      args: [quoteIn, 0n, from],
      // Native curves are paid with tx value; ERC-20 curves pull the quote
      // asset with transferFrom, so this only simulates once the caller holds
      // it and has approved the curve.
      ...(info.native ? { value: quoteIn } : {}),
      account: from,
    });
    return result as bigint;
  } catch { return null; }
}

/** Quote asset out for selling `tokensIn`. Needs the curve already approved. */
export async function quoteSell(info: PonsInfo, tokensIn: bigint, from: Address): Promise<bigint | null> {
  try {
    const { result } = await clientFor("robinhood").simulateContract({
      address: info.curve, abi: CURVE_ABI, functionName: "sell",
      args: [tokensIn, 0n, from], account: from,
    });
    return result as bigint;
  } catch { return null; }
}

export const buyData = (quoteIn: bigint, minTokensOut: bigint, recipient: Address): Hex =>
  encodeFunctionData({ abi: CURVE_ABI, functionName: "buy", args: [quoteIn, minTokensOut, recipient] });

export const sellData = (tokensIn: bigint, minQuoteOut: bigint, recipient: Address): Hex =>
  encodeFunctionData({ abi: CURVE_ABI, functionName: "sell", args: [tokensIn, minQuoteOut, recipient] });

/**
 * Spot quote-per-token from the pricing reserves.
 *
 * Uses getReserves(), which carries the phantom quote that sets the opening
 * price. realQuoteReserve() is the cash actually taken in and sits near zero on
 * a fresh launch, so pricing off it would report a price near zero.
 */
export function spotPrice(info: PonsInfo): number | null {
  if (info.tokenReserve <= 0n || info.quoteReserve <= 0n) return null;
  const q = Number(info.quoteReserve) / 10 ** info.pairDecimals;
  const t = Number(info.tokenReserve) / 1e18;
  return t > 0 ? q / t : null;
}

/**
 * The V4 pool key a graduated Pons token trades on.
 *
 * Reconstructed from the launch record rather than looked up: fee is always 0
 * because the shared hook charges instead, the hook is fixed, and the tick
 * spacing is recorded at launch. This resolves a pool the moment it graduates,
 * before any indexer has seen it.
 */
export function graduatedPoolKey(info: PonsInfo) {
  const a = info.token, b = info.native ? ZERO : info.pairToken;
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee: 0, tickSpacing: info.tickSpacing, hooks: PONS_MEME_HOOK };
}
