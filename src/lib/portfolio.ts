import type { Address } from "viem";
import { formatEther } from "viem";
import { RH_STOCKS, USDG, ERC20_ABI, publicClient } from "./chain";
import { nativeBalance, tokenBalance } from "./wallet";
import { listTokens } from "./tokens";
import { DEFAULT_CHAIN, type ChainKey } from "./chains";
import * as sol from "./solana";
import { api } from "./dex";
import { formatUnitsNum } from "./format";

export type Row = {
  kind: "native" | "token" | "stock";
  symbol: string;
  name: string;
  address?: Address; // undefined for native
  balanceRaw: bigint;
  balance: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
};

export type Portfolio = { rows: Row[]; totalUsd: number | null };

export async function loadPortfolio(address: Address, chain: ChainKey = DEFAULT_CHAIN): Promise<Portfolio> {
  const rows: Row[] = [];
  // USDG and the tokenised stocks are Robinhood-only; on other chains those
  // sections are skipped entirely rather than queried and found empty.
  const isRH = chain === DEFAULT_CHAIN;

  // Native ETH + its price
  const [ethRaw, ethUsdWrap] = await Promise.all([
    nativeBalance(address, chain).catch(() => 0n),
    api.nativePrice().catch(() => ({ usd: null as number | null })),
  ]);
  const ethUsd = ethUsdWrap.usd;
  const ethBal = Number(formatEther(ethRaw));
  rows.push({
    kind: "native",
    symbol: "ETH",
    name: "Ethereum",
    balanceRaw: ethRaw,
    balance: ethBal,
    decimals: 18,
    priceUsd: ethUsd,
    valueUsd: ethUsd == null ? null : ethBal * ethUsd,
  });

  // USDG stablecoin (a base asset on Robinhood Chain, always shown like ETH).
  if (isRH) try {
    const [usdgRaw, usdgDec] = await Promise.all([
      tokenBalance(USDG, address).catch(() => 0n),
      publicClient
        .readContract({ address: USDG, abi: ERC20_ABI, functionName: "decimals" })
        .catch(() => 6),
    ]);
    const usdgBal = formatUnitsNum(usdgRaw, Number(usdgDec));
    rows.push({
      kind: "token",
      symbol: "USDG",
      name: "Global Dollar",
      address: USDG,
      balanceRaw: usdgRaw,
      balance: usdgBal,
      decimals: Number(usdgDec),
      priceUsd: 1,
      valueUsd: usdgBal * 1,
    });
  } catch { /* skip usdg on rpc error */ }

  // Tracked tokens (custom + traded) for this chain only
  const tracked = await listTokens(chain);
  await Promise.all(
    tracked.map(async (t) => {
      const raw = await tokenBalance(t.address, address, chain).catch(() => 0n);
      const bal = formatUnitsNum(raw, t.decimals);
      let price: number | null = null;
      try {
        const info = await api.tokenInfo(t.address);
        price = info.priceUsd;
      } catch { /* api offline */ }
      rows.push({
        kind: "token",
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        balanceRaw: raw,
        balance: bal,
        decimals: t.decimals,
        priceUsd: price,
        valueUsd: price == null ? null : bal * price,
      });
    }),
  );

  // Stocks the user holds (balance > 0), priced via the API
  let stockPrices: Record<string, number | null> = {};
  if (isRH) try {
    const { stocks } = await api.stocks();
    stockPrices = Object.fromEntries(stocks.map((s) => [s.address.toLowerCase(), s.priceUsd]));
  } catch { /* api offline */ }
  if (isRH) await Promise.all(
    RH_STOCKS.map(async (s) => {
      const raw = await tokenBalance(s.address, address).catch(() => 0n);
      if (raw <= 0n) return;
      const bal = formatUnitsNum(raw, 18);
      const price = stockPrices[s.address.toLowerCase()] ?? null;
      rows.push({
        kind: "stock",
        symbol: s.symbol,
        name: s.name,
        address: s.address,
        balanceRaw: raw,
        balance: bal,
        decimals: 18,
        priceUsd: price,
        valueUsd: price == null ? null : bal * price,
      });
    }),
  );

  const known = rows.filter((r) => r.valueUsd != null);
  const totalUsd = known.length ? known.reduce((a, r) => a + (r.valueUsd || 0), 0) : null;
  return { rows, totalUsd };
}

/**
 * Solana holdings.
 *
 * Separate from loadPortfolio rather than a branch inside it: the address is
 * base58 not hex, balances come from token accounts rather than per-token
 * balanceOf calls, and there are no stocks or USDG. Forcing both through one
 * function would mean an `any`-typed address and a body that is two functions
 * wearing a trench coat.
 *
 * One getTokenAccountsByOwner call returns every SPL balance at once, so the
 * cost is flat no matter how many tokens are held — unlike the EVM path, which
 * is one call per tracked token.
 */
export async function loadSolPortfolio(address: string): Promise<Portfolio> {
  const rows: Row[] = [];
  const [lamports, holdings, solUsd] = await Promise.all([
    sol.solBalance(address).catch(() => 0n),
    sol.splHoldings(address).catch(() => []),
    solPriceUsd().catch(() => null),
  ]);

  const solBal = Number(lamports) / 1e9;
  rows.push({
    kind: "native", symbol: "SOL", name: "Solana",
    balanceRaw: lamports, balance: solBal, decimals: 9,
    priceUsd: solUsd, valueUsd: solUsd == null ? null : solBal * solUsd,
  });

  // Price and name every mint in one DexScreener call (it accepts a
  // comma-separated list, capped at 30 addresses).
  const meta = await solTokenMeta(holdings.map((h) => h.mint)).catch(() => ({} as Record<string, any>));
  for (const h of holdings) {
    const m = meta[h.mint.toLowerCase()] || {};
    const bal = formatUnitsNum(h.amountRaw, h.decimals);
    rows.push({
      kind: "token",
      symbol: m.symbol || h.mint.slice(0, 4) + "…",
      name: m.name || "SPL token",
      address: h.mint as any,
      balanceRaw: h.amountRaw,
      balance: bal,
      decimals: h.decimals,
      priceUsd: m.priceUsd ?? null,
      valueUsd: m.priceUsd == null ? null : bal * m.priceUsd,
    });
  }

  rows.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const totalUsd = rows.reduce((t, r) => (r.valueUsd == null ? t : t + r.valueUsd), 0);
  return { rows, totalUsd };
}

async function solPriceUsd(): Promise<number | null> {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${sol.WSOL}`);
  if (!r.ok) return null;
  const pairs = ((await r.json())?.pairs || []).filter((p: any) => p.chainId === "solana" && p.priceUsd);
  pairs.sort((a: any, b: any) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0));
  return pairs[0] ? Number(pairs[0].priceUsd) : null;
}

async function solTokenMeta(mints: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    if (!batch.length) break;
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`);
    if (!r.ok) continue;
    for (const p of (await r.json())?.pairs || []) {
      if (p.chainId !== "solana") continue;
      const k = (p.baseToken?.address || "").toLowerCase();
      const liq = Number(p.liquidity?.usd) || 0;
      if (!k || (out[k] && out[k]._liq >= liq)) continue;
      out[k] = { symbol: p.baseToken?.symbol, name: p.baseToken?.name, priceUsd: Number(p.priceUsd) || null, _liq: liq };
    }
  }
  return out;
}
