// Market cap at a point in time.
//
// Two paths to the same number. The candle path is one HTTP call and is what
// you should normally use; the swap path reads the actual on-chain trade and
// exists for tokens too new or too thin to be indexed, and for when you want
// the transaction hash as evidence alongside the figure.
//
// Neither needs an archive node — which matters, because this chain's public
// RPC keeps state for about 5,000 blocks (~8 minutes at 0.101s blocks). Reading
// historical *state* is impossible here; reading historical *logs* is not.
//
// Full write-up, including the traps, in docs/historical-mcap.md.

import { keccak256, toHex, formatUnits, getAddress, type Address } from "viem";
import { publicClient } from "./chain";

// The shared ERC20_ABI has no totalSupply — it is a trading surface, not a
// metadata one. Kept local rather than widening it for one caller.
const SUPPLY_ABI = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** Measured on Robinhood Chain. Only used to seed a search, so it can drift. */
const BLOCK_TIME_SEC = 0.101;

const SWAP_V2 = keccak256(toHex("Swap(address,uint256,uint256,uint256,uint256,address)"));
const SWAP_V3 = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));

const PAIR_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export type McapResult = {
  /** Fully diluted value in USD: price x totalSupply. */
  mcap: number;
  priceUsd: number;
  supply: number;
  /** Unix seconds of the data point actually used. */
  at: number;
  /** How far that sits from what was asked for. Negative = earlier. */
  offsetSec: number;
  source: "candle" | "swap";
  /** Present on the swap path — the trade this was read from. */
  txHash?: string;
  blockNumber?: bigint;
};

/* ── supply ────────────────────────────────────────────────────────────── */

/**
 * Current total supply, used as a stand-in for supply at `t`.
 *
 * Correct for fixed-supply tokens, which is everything Pons launches and every
 * tokenised stock. A mintable token would need its supply captured at the time;
 * it cannot be recovered afterwards without archive state.
 */
async function totalSupply(ca: Address): Promise<number> {
  const [raw, dec] = await Promise.all([
    publicClient.readContract({ address: ca, abi: SUPPLY_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    publicClient.readContract({ address: ca, abi: SUPPLY_ABI, functionName: "decimals" }) as Promise<number>,
  ]);
  return Number(formatUnits(raw, Number(dec)));
}

/* ── path A: GeckoTerminal candle ──────────────────────────────────────── */

/**
 * Price in USD at or before `ts`, from the OHLCV index.
 *
 * `token` is NOT optional. Without it the endpoint prices the pool in its
 * default orientation, which is usually the other side of the pair — a silent
 * wrong answer that looks entirely plausible (0.9994 instead of 337.82).
 */
async function priceFromCandle(
  pool: string, ca: Address, ts: number,
): Promise<{ price: number; at: number } | null> {
  // Minute first for precision, hour as a fallback: minute retention is short.
  for (const tf of ["minute", "hour"] as const) {
    const url =
      `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${encodeURIComponent(pool)}` +
      `/ohlcv/${tf}?aggregate=1&before_timestamp=${ts}&limit=1&currency=usd&token=${ca}`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const k = (await r.json())?.data?.attributes?.ohlcv_list?.[0];
      if (Array.isArray(k) && Number(k[4]) > 0) return { price: Number(k[4]), at: Number(k[0]) };
    } catch { /* try the next timeframe */ }
  }
  return null;
}

/* ── path B: the actual swap ───────────────────────────────────────────── */

/**
 * Block at or nearest to a timestamp.
 *
 * Seeded from the block time rather than binary-searched: a blind search over a
 * two-million block range took 7.6 seconds, this takes three or four calls.
 */
async function blockAtTime(ts: number): Promise<bigint> {
  const head = await publicClient.getBlock();
  let guess = head.number - BigInt(Math.round((Number(head.timestamp) - ts) / BLOCK_TIME_SEC));
  if (guess < 1n) guess = 1n;

  for (let i = 0; i < 40; i++) {
    const b = await publicClient.getBlock({ blockNumber: guess });
    const drift = Number(b.timestamp) - ts;
    if (Math.abs(drift) < 2) return guess;
    const step = BigInt(Math.max(1, Math.round(Math.abs(drift) / BLOCK_TIME_SEC)));
    guess = drift > 0 ? guess - step : guess + step;
    if (guess < 1n) return 1n;
    if (guess > head.number) return head.number;
  }
  return guess;
}

/** Price in QUOTE units from the swap nearest `blk`, plus which trade it was. */
async function priceFromSwap(pool: string, ca: Address, blk: bigint) {
  const addr = getAddress(pool);
  const [t0, t1] = await Promise.all([
    publicClient.readContract({ address: addr, abi: PAIR_ABI, functionName: "token0" }) as Promise<Address>,
    publicClient.readContract({ address: addr, abi: PAIR_ABI, functionName: "token1" }) as Promise<Address>,
  ]);
  const dec = (a: Address) =>
    publicClient.readContract({ address: a, abi: SUPPLY_ABI, functionName: "decimals" }) as Promise<number>;
  const [d0, d1] = await Promise.all([dec(t0), dec(t1)]);
  const tokenIs0 = t0.toLowerCase() === ca.toLowerCase();

  // Widen until a trade is caught. Always filtered by address: an unfiltered
  // query over 500 blocks returned 13,550 logs and exceeded the size limit.
  for (const span of [600n, 6_000n, 60_000n, 400_000n]) {
    const from = blk > span ? blk - span : 0n;
    const logs = await publicClient
      .getLogs({ address: addr, fromBlock: from, toBlock: blk + span })
      .catch(() => []);
    const swaps = logs.filter((l) => l.topics[0] === SWAP_V2 || l.topics[0] === SWAP_V3);
    if (!swaps.length) continue;

    const dist = (n: bigint) => (n > blk ? n - blk : blk - n);
    const near = swaps.reduce((a, b) => (dist(b.blockNumber!) < dist(a.blockNumber!) ? b : a));

    const hex = near.data.slice(2);
    const word = (i: number) => BigInt("0x" + hex.slice(i * 64, i * 64 + 64));
    // int256 comes back unsigned; fold the top half back to negative.
    const signed = (x: bigint) => (x >= 1n << 255n ? x - (1n << 256n) : x);
    const abs = (x: bigint) => (x < 0n ? -x : x);

    let amt0: number, amt1: number;
    if (near.topics[0] === SWAP_V2) {
      amt0 = Number(formatUnits(word(0) + word(2), Number(d0)));   // in + out
      amt1 = Number(formatUnits(word(1) + word(3), Number(d1)));
    } else {
      amt0 = Number(formatUnits(abs(signed(word(0))), Number(d0)));
      amt1 = Number(formatUnits(abs(signed(word(1))), Number(d1)));
    }
    if (!amt0 || !amt1) continue;

    const block = await publicClient.getBlock({ blockNumber: near.blockNumber! });
    return {
      price: tokenIs0 ? amt1 / amt0 : amt0 / amt1,   // quote units per token
      at: Number(block.timestamp),
      txHash: near.transactionHash as string,
      blockNumber: near.blockNumber!,
    };
  }
  return null;
}

/* ── public ────────────────────────────────────────────────────────────── */

/**
 * Fully diluted market cap of `ca` at unix second `ts`.
 *
 * `pool` should be the deepest pair, ideally quoted in USDG or WETH — see the
 * note on quote denomination in the docs. Returns null when nothing traded
 * anywhere near that moment, which is a real answer, not a failure.
 *
 * Set `exact` to read the on-chain trade instead of the candle. It costs about
 * fifteen RPC calls versus one HTTP request, and buys you the tx hash.
 */
export async function mcapAt(
  ca: string, pool: string, ts: number, opts: { exact?: boolean } = {},
): Promise<McapResult | null> {
  const token = getAddress(ca);
  const supply = await totalSupply(token);
  if (!supply) return null;

  if (!opts.exact) {
    const c = await priceFromCandle(pool, token, ts);
    if (c) {
      return {
        mcap: c.price * supply, priceUsd: c.price, supply,
        at: c.at, offsetSec: c.at - ts, source: "candle",
      };
    }
  }

  const blk = await blockAtTime(ts);
  const s = await priceFromSwap(pool, token, blk);
  if (!s) return null;

  // The swap gives a price in quote units. Converting that to USD needs the
  // quote's own price at the same moment, and the candle already carries it —
  // so use the candle to derive the rate rather than resolving a second market.
  const c = await priceFromCandle(pool, token, ts);
  const quoteUsd = c && s.price > 0 ? c.price / s.price : null;
  if (quoteUsd == null) return null;

  const priceUsd = s.price * quoteUsd;
  return {
    mcap: priceUsd * supply, priceUsd, supply,
    at: s.at, offsetSec: s.at - ts, source: "swap",
    txHash: s.txHash, blockNumber: s.blockNumber,
  };
}
