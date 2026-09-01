// Robinhood Chain routing — a port of StrixBot's main.py trade path.
//
// Why this file exists separately from dexcore.ts: Robinhood's Uniswap V4 is a
// FORK, and three of its behaviours break the generic machinery.
//
//   1. Pools are created through the PositionManager and the PoolManager emits
//      no standard Initialize event for many of them, so resolving a PoolKey by
//      log scan silently returns null on pools that trade fine. The
//      PositionManager's poolKeys(bytes25) mapping is the reliable source.
//
//   2. Tokens minted on the RH launchpad have NO Uniswap pool until they
//      graduate. They trade on a per-token bonding curve. Every pool-based
//      route fails on them, which is why they simply could not be bought here.
//
//   3. The deepest pool for an RH token often pairs against ANOTHER token — a
//      tokenized stock like NVDA — rather than WETH or USDG. Routing such a
//      token through whichever pool happens to be detected first dumps it into
//      a thin side-pool for a fraction of its value. The bot lost real money
//      that way before it learned to rank pools by depth and route through the
//      deepest one with a multi-hop path.
//
// So: launchpad first, then deepest-pool ranking, then a route built for
// whatever that pool turns out to be paired against.

import { encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { CHAINS, clientFor } from "./chains";
import { USDG, isStock } from "./chain";
import * as dx from "./dexcore";
import * as pons from "./pons";

const RH = CHAINS.robinhood;
const ZERO = dx.ZERO;
const WETH = RH.weth;

/* ── bonding-curve launchpad ─────────────────────────────────────────────── */
// Lives in pons.ts: the curve interface is large enough, and specific enough to
// the launchpad, that mixing it into pool routing would obscure both.

/* ── PoolKey resolution ──────────────────────────────────────────────────── */

const POOLKEYS_ABI = parseAbi([
  "function poolKeys(bytes25 poolId) view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)",
]);

const keyCache = new Map<string, dx.PoolKey | null>();

/**
 * Exact PoolKey for a pool id.
 *
 * PositionManager.poolKeys first: one call, works for hooked and USDG pools,
 * and it is the path Robinhood's own router uses. The Initialize log scan is
 * the fallback for native pools created directly on the PoolManager. Cached
 * forever — a pool's key cannot change.
 */
export async function poolKeyFromId(poolId: string): Promise<dx.PoolKey | null> {
  const id = (poolId || "").toLowerCase();
  // A V4 pool id is 32 bytes. DexScreener reports a 20-byte contract address
  // for V2/V3 pairs, and padding one of those into bytes25 reads a slot that is
  // always empty — so reject by length rather than burning a call to find out.
  if (!/^0x[0-9a-f]{64}$/.test(id)) return null;
  if (keyCache.has(id)) return keyCache.get(id)!;

  let out: dx.PoolKey | null = null;
  const pm = RH.v4PositionManager;
  if (pm && pm !== ZERO) {
    try {
      // bytes25 = the first 25 bytes of the pool id.
      const short = ("0x" + id.replace(/^0x/, "").padStart(64, "0").slice(0, 50)) as Hex;
      const k = (await clientFor("robinhood").readContract({
        address: pm, abi: POOLKEYS_ABI, functionName: "poolKeys", args: [short],
      })) as any as [Address, Address, number, number, Address];
      // An unregistered id returns all zeros; a native pool legitimately has
      // currency0 = 0x0, so both currencies must be zero to call it empty.
      if (BigInt(k[0]) !== 0n || BigInt(k[1]) !== 0n) {
        out = {
          currency0: getAddress(k[0]), currency1: getAddress(k[1]),
          fee: Number(k[2]), tickSpacing: Number(k[3]), hooks: getAddress(k[4]),
        };
      }
    } catch { out = null; }
  }
  if (!out) out = await dx.fetchV4PoolKey(poolId, RH);

  keyCache.set(id, out);
  return out;
}

/* ── deepest-pool routing ────────────────────────────────────────────────── */

export type RhRoute =
  | { version: "curve"; pons: pons.PonsInfo; fairPriceUsd: number | null }
  | { version: "multihop"; path: dx.PathKey[]; liqUsd: number; fairPriceUsd: number | null }
  | { version: "v4"; base: "native"; poolKey: dx.PoolKey; liqUsd: number; priceUsd: number | null; fairPriceUsd: number | null }
  | { version: "v4"; base: "usdg"; fee: number; tickSpacing: number; hooks: Address; liqUsd: number; priceUsd: number | null; fairPriceUsd: number | null }
  | { version: "v2" | "v3"; liqUsd: number; priceUsd: number | null; fairPriceUsd: number | null };

const NATIVE_SET = new Set([ZERO.toLowerCase(), WETH.toLowerCase()]);

const pairVersion = (p: any): "v2" | "v3" | "v4" => {
  const labels = (p?.labels || []).map((x: any) => String(x).toLowerCase());
  if (labels.includes("v4")) return "v4";
  if (labels.includes("v3")) return "v3";
  if (labels.includes("v2")) return "v2";
  return "v4";
};

/** Can we trade this pair directly? V2/V3 only against WETH; V4 also USDG. */
const routable = (p: any): boolean => {
  const q = String(p?.quoteToken?.address || "").toLowerCase();
  const v = pairVersion(p);
  if (v === "v2" || v === "v3") return NATIVE_SET.has(q);
  return NATIVE_SET.has(q) || q === USDG.toLowerCase();
};

const liqOf = (p: any) => Number(p?.liquidity?.usd) || 0;

/**
 * Robinhood pairs where `token` is the BASE side.
 *
 * DexScreener returns every pair the token appears in, on either side. Pairs
 * where it is the QUOTE — AI/NVDA when you asked about NVDA — describe a
 * different token's market: their priceUsd is AI's price, not NVDA's, and
 * their liquidity belongs to AI's pool. Ranking on those picks the wrong pool
 * and, worse, feeds the wrong number to the price guard, which is the one
 * check standing between a user and a bad fill.
 */
async function fetchRhPairs(token: string): Promise<any[]> {
  const tl = token.toLowerCase();
  try {
    const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + token);
    if (!r.ok) return [];
    return ((await r.json())?.pairs || []).filter(
      (p: any) => p.chainId === "robinhood"
        && String(p.baseToken?.address || "").toLowerCase() === tl,
    );
  } catch { return []; }
}

/* ── multi-hop path building ─────────────────────────────────────────────── */

// Fee tiers to probe when a hop's pool key cannot be read from its id.
const HOP_FEES: [number, number][] = [
  [3000, 60], [10000, 200], [500, 10], [100000, 1000], [2500, 50], [100, 1], [0, 200],
];

/** Probe fee tiers for an unhooked tokenIn→tokenOut V4 pool by quoting dust. */
async function probeHopKey(tokenIn: Address, tokenOut: Address): Promise<[number, number, Address] | null> {
  const [c0, c1] = BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
  const zeroForOne = c0.toLowerCase() === tokenIn.toLowerCase();
  for (const [fee, tickSpacing] of HOP_FEES) {
    const out = await dx.v4QuoteSingle(
      { currency0: c0, currency1: c1, fee, tickSpacing, hooks: ZERO }, zeroForOne, 10n ** 15n, RH);
    if (out && out > 0n) return [fee, tickSpacing, ZERO];
  }
  return null;
}

/** (fee, tickSpacing, hooks) for a hop — exact key first, probe as fallback. */
async function hopKey(tokenIn: Address, tokenOut: Address, pair: any): Promise<[number, number, Address] | null> {
  if (pair?.pairAddress) {
    const k = await poolKeyFromId(pair.pairAddress);
    if (k && (k.fee || k.tickSpacing || BigInt(k.hooks) !== 0n))
      return [k.fee, k.tickSpacing, k.hooks];
  }
  return probeHopKey(tokenIn, tokenOut);
}

/**
 * Build a V4 path from `token` out to WETH by following deepest pools.
 *
 * Returns null when no path to ETH exists, and the caller must then refuse to
 * trade rather than fall back to a thin pool — "no route" is a safe answer,
 * "some route" is not.
 */
export async function routePath(token: Address, depth = 0, seen = new Set<string>()): Promise<dx.PathKey[] | null> {
  const tl = token.toLowerCase();
  if (depth > 3 || seen.has(tl)) return null;
  seen = new Set(seen).add(tl);

  const pairs = await fetchRhPairs(token);
  if (!pairs.length) return null;
  const pair = pairs.reduce((a, b) => (liqOf(b) > liqOf(a) ? b : a));
  const base = String(pair?.quoteToken?.address || "");
  if (!base) return null;
  const bl = base.toLowerCase();

  const hk = await hopKey(token, getAddress(base), pair);
  if (!hk) return null;
  const [fee, tickSpacing, hooks] = hk;

  // Base cases: already at ETH/WETH, or at USDG which has a direct WETH bridge.
  if (NATIVE_SET.has(bl)) return [{ currency: WETH, fee, tickSpacing, hooks }];
  if (bl === USDG.toLowerCase())
    return [
      { currency: USDG, fee, tickSpacing, hooks },
      { currency: WETH, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: ZERO },
    ];
  // Base is a tokenized stock → stock → USDG → WETH.
  if (isStock(getAddress(base)))
    return [
      { currency: getAddress(base), fee, tickSpacing, hooks },
      { currency: USDG, fee: dx.RH_STOCK_FEE, tickSpacing: dx.RH_STOCK_TS, hooks: ZERO },
      { currency: WETH, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: ZERO },
    ];
  // Base is some other token → recurse and prepend this hop.
  const rest = await routePath(getAddress(base), depth + 1, seen);
  if (!rest) return null;
  return [{ currency: getAddress(base), fee, tickSpacing, hooks }, ...rest];
}

/**
 * Turn a token→…→WETH sell path into a WETH→…→token buy path.
 *
 * Each hop keeps its own pool's fee/tickSpacing/hooks; only the direction and
 * the "next currency" of each PathKey flip.
 */
export function reversePath(token: Address, sellPath: dx.PathKey[]): dx.PathKey[] {
  const currencies = [token, ...sellPath.map((h) => h.currency)]; // [token, …, WETH]
  const params = sellPath.map((h) => ({ fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks }));
  const outs = currencies.slice(0, -1).reverse();                 // [c(n-1), …, token]
  const revParams = [...params].reverse();
  return outs.map((currency, i) => ({ currency, ...revParams[i] }));
}

/** Quote an exact-in multi-hop swap through the V4 quoter. */
export async function quoteMultihop(currencyIn: Address, path: dx.PathKey[], amountIn: bigint): Promise<bigint | null> {
  return dx.callQuoter(RH.v4Quoter, dx.V4_QUOTER_MULTI_ABI, "quoteExactInput", [{
    exactCurrency: currencyIn,
    path: path.map((h) => ({ intermediateCurrency: h.currency, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: "0x" as Hex })),
    exactAmount: amountIn,
  }], RH);
}

/* ── the router ──────────────────────────────────────────────────────────── */

const bestCache = new Map<string, { t: number; v: RhRoute | null }>();
const BEST_TTL = 300_000; // which pool is deepest changes slowly; quotes stay live

/**
 * The deepest tradable route for a Robinhood token.
 *
 * Ranks by DexScreener USD liquidity, tracking the deepest ROUTABLE pair
 * separately from the deepest pair overall. The overall one may sit in a pool
 * we cannot route directly (a stock pair), but its price is the token's true
 * market price, so it is carried as `fairPriceUsd` for the trade guards.
 *
 * When the deepest pool is unroutable AND meaningfully deeper than anything we
 * can reach directly, a multi-hop path is built through it. That is where the
 * real liquidity is; the alternative is filling against a side-pool that has
 * almost none.
 */
export async function bestPool(token: Address): Promise<RhRoute | null> {
  const tl = token.toLowerCase();
  if (!tl || tl === USDG.toLowerCase()) return null;

  const hit = bestCache.get(tl);
  if (hit && Date.now() - hit.t < BEST_TTL) return hit.v;

  const route = await computeBestPool(token);
  bestCache.set(tl, { t: Date.now(), v: route });
  return route;
}

/**
 * Route for a graduated Pons token, built from its launch record.
 *
 * The pool key is deterministic, so this works the instant a token graduates —
 * before DexScreener indexes it, which is exactly the window in which people
 * try to trade a token that just filled its curve. Confirmed against a live
 * pool before being trusted: if the key does not quote, we fall through to
 * ordinary ranking rather than encode a swap into a pool that may not exist.
 */
async function ponsGraduatedRoute(p: pons.PonsInfo): Promise<RhRoute | null> {
  const key = pons.graduatedPoolKey(p);
  const zeroForOne = key.currency0.toLowerCase() === p.token.toLowerCase();
  const probe = await dx.v4QuoteSingle(key, zeroForOne, 10n ** 15n, RH);
  if (!probe || probe <= 0n) return null;

  if (p.native)
    return { version: "v4", base: "native", poolKey: key, liqUsd: 0, priceUsd: null, fairPriceUsd: null };

  // A graduation quoted in cbBTC or USDG is one hop from ETH, not zero. Build
  // the path with the known Pons hop first, then whatever gets its quote asset
  // home — so a token is tradable the moment it graduates, before any indexer
  // has a pair for it.
  const first: dx.PathKey = { currency: p.pairToken, fee: 0, tickSpacing: p.tickSpacing, hooks: pons.PONS_MEME_HOOK };
  const rest = p.pairToken.toLowerCase() === USDG.toLowerCase()
    ? [{ currency: WETH, fee: dx.RH_BRIDGE_FEE, tickSpacing: dx.RH_BRIDGE_TS, hooks: ZERO }]
    : await routePath(p.pairToken);
  if (!rest?.length) return null;
  return { version: "multihop", path: [first, ...rest], liqUsd: 0, fairPriceUsd: null };
}

async function computeBestPool(token: Address): Promise<RhRoute | null> {
  // Pons first. A token on its curve has no pool for any ranking to find, and a
  // freshly graduated one has a pool no indexer has seen yet — both are answered
  // from the launch record instead of from DexScreener.
  const p = await pons.ponsInfo(token);
  if (p?.onCurve || p?.phase === 1) return { version: "curve", pons: p, fairPriceUsd: null };
  if (p && (p.phase === 2 || p.phase === 3)) {
    const graduated = await ponsGraduatedRoute(p);
    if (graduated) return graduated;
  }

  const pairs = await fetchRhPairs(token);
  if (!pairs.length) return null;

  let best: any = null, bestLiq = -1;
  let overall: any = null, overallLiq = -1;
  for (const p of pairs) {
    const liq = liqOf(p);
    if (liq > overallLiq) { overallLiq = liq; overall = p; }
    if (routable(p) && liq > bestLiq) { bestLiq = liq; best = p; }
  }
  const fairPriceUsd = Number(overall?.priceUsd) || null;

  // Deepest pool pairs against another token and dwarfs anything routable →
  // trade THROUGH it. 1.5x rather than any margin: a marginally deeper
  // token-paired pool is not worth the extra hops and their fees.
  if (overall && !routable(overall) && overallLiq > Math.max(bestLiq, 0) * 1.5) {
    const path = await routePath(token);
    if (path) return { version: "multihop", path, liqUsd: overallLiq, fairPriceUsd };
  }

  if (!best?.pairAddress) return null;
  const quote = String(best.quoteToken?.address || "").toLowerCase();
  const priceUsd = Number(best.priceUsd) || null;
  const ver = pairVersion(best);

  // V2/V3 WETH pools go through the generic machinery — no key to resolve.
  if (ver === "v2" || ver === "v3") return { version: ver, liqUsd: bestLiq, priceUsd, fairPriceUsd };

  const key = await poolKeyFromId(best.pairAddress);
  if (!key) return null;

  if (quote === USDG.toLowerCase())
    return { version: "v4", base: "usdg", fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, liqUsd: bestLiq, priceUsd, fairPriceUsd };
  if (NATIVE_SET.has(quote))
    return { version: "v4", base: "native", poolKey: key, liqUsd: bestLiq, priceUsd, fairPriceUsd };
  return null;
}

/* ── price guards ────────────────────────────────────────────────────────── */

/** Reject a fill this much worse than the token's true market price. */
const MAX_IMPACT = 0.6;

/** A pool shallower than this is not a market, and a swap into it is a
 *  donation. Deliberately low: real early tokens do trade on thin pools, and
 *  the size rule below is what protects against them. */
const MIN_POOL_USD = 500;

/** The most of a pool's depth one trade may be. Above roughly a tenth, the
 *  constant-product curve moves against you faster than any slippage setting
 *  a user would think to choose. */
const MAX_POOL_SHARE = 0.1;

/** USD liquidity behind a route, or null when it is not a ranked pool. */
export const routeLiquidity = (r: RhRoute | null): number | null =>
  r && "liqUsd" in r && r.liqUsd > 0 ? r.liqUsd : null;

/**
 * Refuse a trade that is too large for the pool behind it.
 *
 * The impact guard below compares a fill against market price, which catches a
 * bad pool. This catches a good pool that is simply too small for the size
 * being pushed through it — the case where nothing is wrong except that the
 * trade itself is what moves the price.
 */
export function liquidityBlock(route: RhRoute | null, tradeUsd: number): string | null {
  const liq = routeLiquidity(route);
  if (liq == null) return null;   // curve trades and unranked routes price themselves
  if (liq < MIN_POOL_USD)
    return `The only pool for this token holds about $${Math.round(liq).toLocaleString()} of liquidity, which is too thin to trade through without losing most of the value. Impulse will not route into it.`;
  if (tradeUsd > 0 && tradeUsd > liq * MAX_POOL_SHARE) {
    const most = liq * MAX_POOL_SHARE;
    return `This trade is about ${Math.round((tradeUsd / liq) * 100)}% of the whole pool, which would move the price against you badly. Keep it under about $${Math.round(most).toLocaleString()}.`;
  }
  return null;
}

export const routeFairPrice = (r: RhRoute | null): number | null =>
  (r && ("fairPriceUsd" in r ? r.fairPriceUsd : null)) ||
  (r && "priceUsd" in r ? r.priceUsd : null) || null;

/**
 * Compare an actual quote against what the market price says it should be.
 *
 * Returns a user-facing message when the fill is far worse, or null to proceed.
 * Both a missing market price and a missing native price mean "cannot judge",
 * and cannot-judge is not the same as bad — those cases pass through, since the
 * slippage floor on the swap itself is still in force.
 */
export function impactError(
  expectedUnits: number | null,
  actualUnits: number | null,
  side: "buy" | "sell",
): string | null {
  if (!expectedUnits || expectedUnits <= 0) return null;
  if (actualUnits == null || actualUnits <= 0)
    return `Couldn't price this token right now, so the ${side} was not sent. Try again in a moment.`;
  if (actualUnits < expectedUnits * (1 - MAX_IMPACT)) {
    const worse = Math.round((1 - actualUnits / expectedUnits) * 100);
    return side === "buy"
      ? `Buy blocked to protect you: it would fill about ${worse}% worse than market because the pool is too thin for this size. Try a smaller amount.`
      : `Sell blocked to protect you: it would return about ${worse}% less than this token is worth. The routable pool is too thin right now.`;
  }
  return null;
}

/** ABI-encoded PathKey[] helper shared with dex.ts (kept here for locality). */
export const encodePathKeys = (path: dx.PathKey[]) =>
  encodeAbiParameters(
    [{ type: "tuple[]", components: [
      { name: "intermediateCurrency", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      { name: "hookData", type: "bytes" }] }],
    [path.map((h) => ({ intermediateCurrency: h.currency, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: "0x" as Hex }))],
  );
