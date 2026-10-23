// Service worker. Two jobs:
//  1. Open the wallet popup window deep-linked to a token (from the X pill).
//  2. Serve the X inline trading terminal: token info, wallet status, and
//     EXECUTING buys. Signing happens ONLY here (a trusted context that can
//     read the unlocked session key) — never in the x.com content script.

import { formatEther, getAddress } from "viem";
import { publicClient, ERC20_ABI } from "./lib/chain";
import { api } from "./lib/dex";
import { bestPair } from "./lib/dexcore";
import { gmgn, hasGmgnKey } from "./lib/gmgn";
import { getUnlockedPk, activeAccount, lock as lockWallet } from "./lib/keystore";
import { nativeBalance, tokenBalance, signAndSend, waitReceipt } from "./lib/wallet";
import { addToken, untrackIfEmpty } from "./lib/tokens";
import * as fomo from "./lib/fomo";
import { topFollowers, cashtagTweets, vetAccount } from "./lib/fomoBackend";
import { traderForX } from "./lib/trader";
import * as impulse from "./lib/impulse";
import * as copyd from "./lib/copyd";
import { CHAINS, CHAIN_LIST, cfgFor, chainByDexId, clientFor, isChainKey, type ChainKey } from "./lib/chains";
import { resolveTokenChain } from "./lib/dexcore";
import * as sol from "./lib/solana";
import { solRpc } from "./lib/solana";
import { getUnlockedSol } from "./lib/keystore";
import { isIdleExpired, touchActivity } from "./lib/settings";
import { formatUnitsNum } from "./lib/format";

/* ── which sites the terminal runs on ──────────────────────────────────────
   X is declared in the manifest and always on. Anything else is opt-in: the
   user grants that one origin, the content script is registered for it, and
   the choice survives restarts. Registered scripts are rebuilt from storage on
   startup because Chrome drops them when a permission is revoked. */

const BUILTIN_ORIGINS = new Set(["https://x.com", "https://twitter.com"]);

/** Hosts allowed to serve an image the panel will inline. Every one is already
 *  in host_permissions; listing them again keeps a metadata URL from steering
 *  a fetch somewhere else. */
// Market Insights (tehcscreener) — keyless, CORS-open, daily data. Fetched here
// (not the content script) so it goes through the extension's host permission,
// and cached per window since it only changes once a day.
const MKT_BASE = "https://tehcscreener.com/api/v1";
const mktCache = new Map<string, { t: number; v: any }>();
async function marketInsights(window: string) {
  const hit = mktCache.get(window);
  if (hit && Date.now() - hit.t < 30 * 60_000) return hit.v;
  const j = async (p: string) => { try { const r = await fetch(MKT_BASE + p); return r.ok ? await r.json() : null; } catch { return null; } };
  const [trench, launchpads, chains] = await Promise.all([
    j("/trench"),
    j(`/launchpads?window=${encodeURIComponent(window)}`),
    j("/chains"),
  ]);
  const v = { window, trench, launchpads, chains };
  mktCache.set(window, { t: Date.now(), v });
  return v;
}

const IMAGE_HOSTS = new Set([
  "dd.dexscreener.com",
  "cdn.dexscreener.com",
  "assets.parqet.com",
  "metadata.mobula.io",
  "token-media.defined.fi",
  "pump.mypinata.cloud",
  "socialimages.pump.fun",
  "prod-fomo-profile-pics.s3.amazonaws.com",
  "tehcscreener.com",   // launchpad + chain logos for Market Insights
]);
const SITES_KEY = "strix.sites.v1";

async function enabledOrigins(): Promise<string[]> {
  const r = await chrome.storage.local.get(SITES_KEY);
  return Array.isArray(r[SITES_KEY]) ? r[SITES_KEY] : [];
}

async function siteEnabled(origin: string): Promise<boolean> {
  if (BUILTIN_ORIGINS.has(origin)) return true;
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return false;
  return (await enabledOrigins()).includes(origin);
}

const scriptId = (origin: string) => "strix-" + origin.replace(/[^a-z0-9]/gi, "-");

/**
 * The bundled content script's path, read from our own manifest.
 *
 * The build content-hashes it (assets/x-inject.tsx-D6WFojgr.js) and that name
 * changes every release, so hardcoding it would work exactly once. Asking the
 * manifest is always right.
 */
function contentScriptFiles(): string[] {
  const cs = chrome.runtime.getManifest().content_scripts ?? [];
  return cs[0]?.js ?? [];
}

async function registerFor(origin: string) {
  const js = contentScriptFiles();
  if (!js.length) return;
  const id = scriptId(origin);
  // Re-registering an existing id throws, so clear it first.
  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id, matches: [`${origin}/*`], js, runAt: "document_idle",
  }]).catch((e) => console.warn("registerContentScripts failed", origin, e));
}

async function enableSite(origin: string): Promise<boolean> {
  if (!/^https?:\/\/[^/]+$/.test(origin)) return false;
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  if (!granted) return false;
  const list = await enabledOrigins();
  if (!list.includes(origin)) await chrome.storage.local.set({ [SITES_KEY]: [...list, origin] });
  await registerFor(origin);
  return true;
}

async function disableSite(origin: string): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] }).catch(() => {});
  const list = (await enabledOrigins()).filter((o) => o !== origin);
  await chrome.storage.local.set({ [SITES_KEY]: list });
  // Hand the permission back — holding one we no longer use is not ours to keep.
  await chrome.permissions.remove({ origins: [`${origin}/*`] }).catch(() => {});
}

/** Rebuild registrations after a browser restart or extension update. */
async function restoreSites() {
  for (const origin of await enabledOrigins()) {
    if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) await registerFor(origin);
  }
}
chrome.runtime.onStartup?.addListener(() => { void restoreSites(); });
chrome.runtime.onInstalled?.addListener(() => { void restoreSites(); });

/**
 * Is this address something you can actually trade?
 *
 * Plenty of addresses posted online are people's wallets, not tokens, and
 * offering "Buy" under someone's donation address is both useless and
 * alarming. An externally owned account has no bytecode, so that check alone
 * removes the common case; asking for decimals() then rejects contracts that
 * are not ERC-20 at all, like a router or an NFT.
 *
 * Cached both ways — a wallet address pasted in a busy thread would otherwise
 * be re-checked on every scroll.
 */
const tokenCheckCache = new Map<string, { t: number; v: boolean }>();
const TOKEN_CHECK_TTL = 30 * 60_000;

/**
 * Open the wallet UI.
 *
 * Firefox for Android has no window manager, so windows.create either throws
 * or is missing entirely there. Falling back to a tab keeps the same flow
 * working on mobile, where the popup would otherwise silently do nothing.
 */
async function openWallet(path: string): Promise<void> {
  const url = chrome.runtime.getURL(path);
  try {
    if (chrome.windows?.create) {
      await chrome.windows.create({ url, type: "popup", width: 400, height: 640 });
      return;
    }
  } catch { /* no window manager - fall through */ }
  await chrome.tabs.create({ url });
}

async function isTradableToken(ca: string, chain: ChainKey = "robinhood"): Promise<boolean> {
  // On Solana "is this a token" is answered by whether a mint exists, not by
  // probing bytecode — there is no EVM client to ask.
  if (CHAINS[chain]?.vm === "svm") {
    const hit = tokenCheckCache.get(chain + ":" + ca);
    if (hit && Date.now() - hit.t < TOKEN_CHECK_TTL) return hit.v;
    let ok = false;
    try {
      const r = await solRpc<any>("getAccountInfo", [ca, { encoding: "jsonParsed" }]);
      const parsed = r?.value?.data?.parsed;
      ok = parsed?.type === "mint";
    } catch { /* rpc down - do not claim it is a token */ }
    tokenCheckCache.set(chain + ":" + ca, { t: Date.now(), v: ok });
    return ok;
  }
  let addr: string;
  try { addr = getAddress(ca); } catch { return false; }

  const cacheKey = chain + ":" + addr;
  const hit = tokenCheckCache.get(cacheKey);
  if (hit && Date.now() - hit.t < TOKEN_CHECK_TTL) return hit.v;

  let ok = false;
  try {
    const code = await clientFor(chain).getCode({ address: addr as `0x${string}` });
    if (code && code !== "0x") {
      // Has code. Confirm it behaves like an ERC-20 before offering a trade.
      // On the chain it actually lives on: reading decimals() from Robinhood
      // for a Base contract always threw, so every non-Robinhood address was
      // silently classified "not a token" and the overlay never mounted.
      await clientFor(chain).readContract({
        address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "decimals",
      });
      ok = true;
    }
  } catch {
    ok = false;   // no code, or not an ERC-20
  }
  tokenCheckCache.set(cacheKey, { t: Date.now(), v: ok });
  return ok;
}

// Resolve a cashtag symbol -> the deepest-liquidity Robinhood Chain token with
// that exact symbol, via DexScreener search. Cached (incl. negative results).
const tickerCache = new Map<string, { t: number; v: { address: string; chain: ChainKey } | null }>();
/**
 * Floors for resolving a cashtag.
 *
 * A ticker is a guess, not an instruction: anyone can mint a token called
 * $PONS, and a cashtag carries no contract. A raw address is exempt — there
 * the user named the exact contract, so it is theirs to judge.
 */
const MIN_LIQUIDITY_USD = 1_000;
const MIN_VOLUME_24H_USD = 1_000;
const MIN_TXNS_24H = 20;

/**
 * Rank impostors out, by scoring what a scammer cannot cheaply fake.
 *
 * Sorting by liquidity — the obvious choice, and what this used to do — is
 * precisely wrong. Liquidity is the one number you can manufacture by adding
 * your own LP, and a real $PONS impostor did exactly that:
 *
 *            liquidity     24h volume     24h txns    pools
 *   fake     $1,862,603    $19            0 buys / 5      1
 *   real     $1,544,085    $2,496,888     3,131        17
 *
 * The fake outranked the real token on liquidity alone while being, in every
 * behavioural sense, dead. Volume, trade count and the number of independent
 * pools cost real money and real counterparties to fake, so they decide it.
 *
 * Pairs are also aggregated per token first: a genuine token is spread across
 * many pools, and judging any single pair understates it.
 */
/**
 * Quote assets worth measuring liquidity in.
 *
 * A pool paired against some other memecoin can show a large dollar figure
 * while holding almost no real asset — the "$500k liquidity, 0.00001 ETH"
 * shape. Only depth against ETH or the chain's stable says anything about
 * whether you can actually sell.
 */
// Quote assets deep enough that liquidity against them is liquidity you could
// actually exit through. This is per-ecosystem: WETH/USDG on Robinhood,
// USDC/USDT off it, and SOL on Solana — omitting SOL made majorLiq read as
// zero for every Solana token and silently disabled the main ranking signal.
const MAJOR_QUOTES = new Set([
  "WETH", "ETH", "USDG", "USDC", "USDT", "DAI", "SOL", "WSOL", "USDC.E",
]);

type TokenAgg = {
  address: string;
  chain: ChainKey;
  liq: number;       // every pool, whatever it is paired with
  majorLiq: number;  // only pools quoted in ETH/WETH/USDG
  vol: number;
  txns: number;
  pools: number;
  socials: number;
};

/**
 * Liquidity a pool can credibly claim.
 *
 * DexScreener reports whatever a pool holds, and minting a token against a
 * large nominal balance is free — so depth is only meaningful where trading
 * corroborates it. Capping at ten times daily volume leaves real markets
 * untouched (they turn over far more than a tenth of their depth) while
 * collapsing an untraded $266M pool to the few hundred thousand it actually
 * moved.
 */
const effLiq = (t: TokenAgg) => Math.min(t.majorLiq, t.vol * 10);

function rankBySymbol(pairs: any[], sym: string): { address: string; chain: ChainKey } | null {
  const byToken = new Map<string, TokenAgg>();

  for (const p of pairs) {
    // Any chain we can trade on, not just Robinhood. Identity is chain+address
    // because the same address on two chains is two different tokens.
    const cfg = chainByDexId(p.chainId);
    if (!cfg) continue;
    if ((p.baseToken?.symbol || "").toUpperCase() !== sym) continue;
    const ca = p.baseToken?.address;
    if (!ca) continue;

    const key = cfg.key + ":" + ca.toLowerCase();
    const t = byToken.get(key)
      || { address: ca, chain: cfg.key, liq: 0, majorLiq: 0, vol: 0, txns: 0, pools: 0, socials: 0 };
    const h24 = p.txns?.h24 || {};
    const liq = Number(p.liquidity?.usd) || 0;

    t.liq += liq;
    if (MAJOR_QUOTES.has((p.quoteToken?.symbol || "").toUpperCase())) t.majorLiq += liq;
    t.vol += Number(p.volume?.h24) || 0;
    t.txns += (Number(h24.buys) || 0) + (Number(h24.sells) || 0);
    t.pools += 1;
    // Take the best profile seen: DexScreener attaches it per pair, and only
    // some of a token's pools carry it.
    t.socials = Math.max(
      t.socials,
      (p.info?.socials?.length || 0) + (p.info?.websites?.length || 0),
    );
    byToken.set(key, t);
  }

  // Floors first, and they are load-bearing. A shell with a filled-in profile
  // is a real thing — one $PONS impostor carries three socials against $9 of
  // daily volume — so socials only get to decide among tokens that are
  // demonstrably alive.
  const viable = [...byToken.values()].filter(
    (t) => t.liq >= MIN_LIQUIDITY_USD && t.vol >= MIN_VOLUME_24H_USD && t.txns >= MIN_TXNS_24H,
  );
  if (!viable.length) return null;

  viable.sort((a, b) =>
    // Having a project attached beats not having one.
    (b.socials > 0 ? 1 : 0) - (a.socials > 0 ? 1 : 0)
    // Then depth you could actually exit through, discounted to what trading
    // corroborates — see effLiq.
    || effLiq(b) - effLiq(a)
    // Then the behavioural signals, which cost real money to fake.
    || b.vol - a.vol
    || b.txns - a.txns
    || b.pools - a.pools,
  );
  const best = viable[0];

  // Socials lead, but they are metadata anyone can buy, and plenty of genuine
  // tokens never fill them in. $HOOD is the case that proves it: the token
  // actually being traded — $647k a day across 4,036 trades — has no profile,
  // while three copycats named ROBINHOOD, HOOD4663 and "Robinhood Markets Inc"
  // all have one. So a token without socials still wins if it dwarfs the
  // profiled one on activity, which is far harder to manufacture.
  // Depth override, on CORROBORATED depth. Raw liquidity is as forgeable as
  // volume in the other direction: cross-chain $CASHCAT and $PONS both matched
  // Solana pools advertising $113M and $266M against 32 trades a day. A pool
  // nobody trades is not depth, so effLiq caps what a pool can claim by what it
  // demonstrably turns over, and only the corroborated figure can beat socials.
  const deepest = viable.reduce((a, b) => (effLiq(b) > effLiq(a) ? b : a));
  if (deepest !== best && effLiq(deepest) >= Math.max(MIN_LIQUIDITY_USD, effLiq(best) * 10)) {
    return { address: deepest.address, chain: deepest.chain };
  }

  const busiest = viable.reduce((a, b) => (b.vol > a.vol ? b : a));
  if (
    busiest !== best &&
    // Volume alone must never win. A token with no depth against a major quote
    // cannot be sold whatever its turnover says, and wash trading buys volume
    // far more cheaply than it buys real liquidity — cross-chain $HOOD is the
    // case that proves it: a Solana token with $0 major liquidity and $1.4M of
    // daily volume was outranking one sitting on $37.7M of USDC pairs.
    effLiq(busiest) >= MIN_LIQUIDITY_USD &&
    busiest.vol >= best.vol * 10 &&
    busiest.txns >= best.txns * 5
  ) {
    return { address: busiest.address, chain: busiest.chain };
  }
  return { address: best.address, chain: best.chain };
}

async function resolveTicker(symbol: string): Promise<{ address: string; chain: ChainKey } | null> {
  const sym = symbol.toUpperCase();
  const c = tickerCache.get(sym);
  if (c && Date.now() - c.t < 5 * 60_000) return c.v;
  let hit: { address: string; chain: ChainKey } | null = null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
    if (r.ok) hit = rankBySymbol((await r.json())?.pairs || [], sym);
  } catch { /* offline */ }
  tickerCache.set(sym, { t: Date.now(), v: hit });
  return hit;
}

// Lenient symbol resolve for the scanner: the deepest-liquidity pair matching
// the symbol on any supported chain, with its market cap and logo. No floors.
type DexLite = { address: string; chain: ChainKey; mcap: number | null; logo: string | null; symbol: string };
const dexLiteCache = new Map<string, { t: number; v: DexLite | null }>();
async function dexTickerLite(symbol: string): Promise<DexLite | null> {
  const sym = symbol.replace(/^\$/, "").toUpperCase();
  if (!sym) return null;
  const c = dexLiteCache.get(sym);
  if (c && Date.now() - c.t < 5 * 60_000) return c.v;
  let out: DexLite | null = null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`);
    if (r.ok) {
      const pairs: any[] = (await r.json())?.pairs || [];
      let best: any = null, bestLiq = -1;
      for (const p of pairs) {
        if (!chainByDexId(p.chainId)) continue;
        if ((p.baseToken?.symbol || "").toUpperCase() !== sym || !p.baseToken?.address) continue;
        const liq = Number(p.liquidity?.usd) || 0;
        if (liq > bestLiq) { bestLiq = liq; best = p; }
      }
      if (best) {
        const cfg = chainByDexId(best.chainId)!;
        out = {
          address: String(best.baseToken.address), chain: cfg.key,
          mcap: Number(best.marketCap) || Number(best.fdv) || null,
          logo: best.info?.imageUrl || null,
          symbol: String(best.baseToken.symbol || sym),
        };
      }
    }
  } catch { /* offline */ }
  dexLiteCache.set(sym, { t: Date.now(), v: out });
  return out;
}

// OHLCV candles from GeckoTerminal (free public API; indexes Robinhood Chain,
// including V4 pools by pool id). `token=<ca>` orients candles to OUR token, so
// base/quote order in the pool doesn't matter. Cached 60s per pool+timeframe.
type Candle = [number, number, number, number, number, number]; // ts,o,h,l,c,v
const TF_MAP: Record<string, { path: string; agg: number; limit: number }> = {
  "15m": { path: "minute", agg: 15, limit: 96 },  // 24h
  "1H": { path: "hour", agg: 1, limit: 120 },     // 5d
  "4H": { path: "hour", agg: 4, limit: 120 },     // 20d
  "1D": { path: "day", agg: 1, limit: 120 },      // 4mo
};
const candleCache = new Map<string, { t: number; v: Candle[] | null }>();
async function fetchCandles(pool: string, ca: string, tf: string, chain: ChainKey = "robinhood"): Promise<Candle[] | null> {
  const gt = cfgFor(chain).geckoterminal;
  const cfg = TF_MAP[tf] || TF_MAP["1H"];
  // Chain in the key: pool addresses are only unique within a chain.
  const key = `${chain}:${pool}:${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.t < 60_000) return hit.v;
  let out: Candle[] | null = null;
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${gt}/pools/${encodeURIComponent(pool)}` +
      `/ohlcv/${cfg.path}?aggregate=${cfg.agg}&limit=${cfg.limit}&token=${encodeURIComponent(ca)}`;
    const r = await fetch(url);
    if (r.ok) {
      const list = (await r.json())?.data?.attributes?.ohlcv_list;
      if (Array.isArray(list) && list.length) {
        out = (list as Candle[]).slice().sort((a, b) => a[0] - b[0]); // oldest → newest
      }
    }
  } catch { /* offline */ }
  candleCache.set(key, { t: Date.now(), v: out });
  return out;
}

// A DexScreener / DexTools / GeckoTerminal URL routes by *pool*, not token: the
// address in /<chain>/<pairAddress> is the liquidity pair, not the contract you
// buy. Resolve the pool to its base token so the buy dock has a real token to
// trade. On Robinhood Chain the pool id is a 64-hex V4 poolId; on ETH/Base it's
// a 40-hex pair contract — either way DexScreener's API maps it to baseToken.
const pairTokenCache = new Map<string, { t: number; v: { ca: string | null; chain: ChainKey | null } }>();
async function resolvePairToken(pair: string, chainHint: ChainKey | null): Promise<{ ca: string | null; chain: ChainKey | null }> {
  const key = pair.toLowerCase();
  const c = pairTokenCache.get(key);
  if (c && Date.now() - c.t < 10 * 60_000) return c.v;
  let v: { ca: string | null; chain: ChainKey | null } = { ca: null, chain: chainHint };
  try {
    const urls: string[] = [];
    // The chain-scoped endpoint is exact; search is the fallback when we don't
    // know the chain (or the scoped lookup misses).
    if (chainHint) urls.push(`https://api.dexscreener.com/latest/dex/pairs/${cfgFor(chainHint).dexscreener}/${encodeURIComponent(pair)}`);
    urls.push(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(pair)}`);
    for (const url of urls) {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const list: any[] = Array.isArray(j?.pairs) ? j.pairs : (j?.pair ? [j.pair] : []);
      // Prefer the row whose pool address is the one we asked about; else first.
      const p = list.find((x) => String(x?.pairAddress || "").toLowerCase() === key) || list[0];
      if (p?.baseToken?.address) {
        v = { ca: String(p.baseToken.address), chain: chainByDexId(p.chainId)?.key || chainHint };
        break;
      }
    }
  } catch { /* offline */ }
  pairTokenCache.set(key, { t: Date.now(), v });
  return v;
}

async function handle(msg: any): Promise<any> {
  switch (msg?.type) {
    case "STRIX_PAIRTOKEN": {
      // Resolve a DexScreener-style pool URL to the token it trades.
      const chainHint: ChainKey | null = isChainKey(msg.chain) ? msg.chain : null;
      return await resolvePairToken(String(msg.pair || ""), chainHint);
    }
    case "STRIX_TICKER": {
      const hit = await resolveTicker(String(msg.symbol || ""));
      return { address: hit?.address || null, chain: hit?.chain || null };
    }
    case "STRIX_DEXTICKER": {
      // Lenient resolve for the timeline scanner: the highest-liquidity pair
      // that matches the symbol on any chain we know, returned WITH its market
      // cap and logo. No trade-safety floors — this only decides what to show
      // (a Buy still opens the strict, safety-checked drawer).
      return { data: await dexTickerLite(String(msg.symbol || "")) };
    }
    case "STRIX_OPEN_TRADE": {
      await openWallet(`index.html?ca=${encodeURIComponent(msg.ca || "")}`);
      return { ok: true };
    }
    case "STRIX_OPEN": {
      await openWallet("index.html");
      return { ok: true };
    }
    case "STRIX_OPEN_COPY": {
      // Deep-link into the Copytrade screen with a handle prefilled (from the
      // overlay "Follow" button).
      await openWallet(`index.html?copy=${encodeURIComponent(String(msg.handle || "").replace(/^@/, ""))}`);
      return { ok: true };
    }
    // ── copytrade (copyd) ───────────────────────────────────────────────────
    case "STRIX_COPY_RESOLVE":
      return await copyd.resolveHandle(String(msg.handle || ""));
    case "STRIX_COPY_CREATE":
      return await copyd.createJob(msg.body || {});
    case "STRIX_COPY_LIST":
      return await copyd.listJobs(String(msg.owner || ""));
    case "STRIX_COPY_GET":
      return await copyd.getJob(String(msg.id || ""));
    case "STRIX_COPY_STOP":
      return await copyd.stopJob(String(msg.id || ""));
    case "STRIX_COPY_MODE":
      return await copyd.setMode(String(msg.id || ""), !!msg.copySells);
    // wallet-level (the one reusable per-user copy wallet)
    case "STRIX_COPY_WALLET":
      return await copyd.getWallet(String(msg.owner || ""));
    case "STRIX_COPY_REVEAL":
      return await copyd.revealWallet(String(msg.owner || ""));
    case "STRIX_COPY_SELL":
      return await copyd.sellWallet(String(msg.owner || ""), msg.body || {});
    case "STRIX_COPY_WITHDRAW":
      return await copyd.withdrawWallet(String(msg.owner || ""));
    case "STRIX_COPY_EXPORT":
      return await copyd.exportWallet(String(msg.owner || ""), String(msg.password || ""));
    case "STRIX_TOKEN": {
      // The panel may not know the chain yet (raw CA pasted into a page), so
      // resolve it here and hand it back for every follow-up call.
      const chain: ChainKey = msg.chain || (await resolveTokenChain(String(msg.ca)))?.cfg.key || "robinhood";
      const info = await api.tokenInfo(msg.ca, chain);
      return { info, chain };
    }
    case "STRIX_ISTOKEN": {
      // Try the named chain first; otherwise ask DexScreener where it lives so
      // a Base contract in a tweet is not dismissed as "not a token".
      if (msg.chain) return { ok: await isTradableToken(String(msg.ca), msg.chain), chain: msg.chain };
      const found = await resolveTokenChain(String(msg.ca));
      if (found) return { ok: await isTradableToken(String(msg.ca), found.cfg.key), chain: found.cfg.key };
      return { ok: await isTradableToken(String(msg.ca), "robinhood"), chain: "robinhood" };
    }
    case "STRIX_SITE_STATUS": {
      const origin = String(msg.origin || "");
      return { enabled: await siteEnabled(origin), builtin: BUILTIN_ORIGINS.has(origin) };
    }
    case "STRIX_SITE_ENABLE": {
      return { ok: await enableSite(String(msg.origin || "")) };
    }
    case "STRIX_SITE_DISABLE": {
      await disableSite(String(msg.origin || ""));
      return { ok: true };
    }
    case "STRIX_PAIR": {
      // Resolve a token/stock to its deepest-liquidity DexScreener pair, for
      // the inline chart. Works for stocks too (their V4 pools are indexed).
      const cfg = cfgFor(msg.chain);
      const pair = await bestPair(msg.ca, cfg);
      return { chain: cfg.dexscreener, pair: pair?.pairAddress || null };
    }
    case "STRIX_CANDLES": {
      return { candles: await fetchCandles(String(msg.pool), String(msg.ca), String(msg.tf || "1H"), msg.chain || "robinhood") };
    }
    case "STRIX_FOMO": {
      // Thesis feed for the panel. Proxied for the same reason as GMGN: a
      // content script cannot reach a third-party host directly.
      const page = await fomo.theses(String(msg.ca), msg.chain ? String(msg.chain) : undefined);
      // Resolve pictures for the rows that will actually be on screen. The
      // panel shows five at a time, so fetching all two hundred would spend the
      // rate limit on rows nobody scrolls to.
      if ("items" in page && page.items.length) {
        // Inline every author avatar (deduped by URL), so paged rows are never blank.
        await fomo.withAvatars(page.items);
      }
      return page;
    }
    case "STRIX_FOMO_TOP": {
      // Lightweight top-N theses for the inline avatar strip under a post: only
      // the highest-position authors, only their avatars inlined, a light shape.
      const n = Math.max(1, Math.min(8, Number(msg.n) || 5));
      const page = await fomo.theses(String(msg.ca), msg.chain ? String(msg.chain) : undefined);
      if (!("items" in page)) return { items: [], symbol: null };
      // One entry per author (each user once) — items are already ranked by
      // position, so the first time we see an author is their biggest position.
      const seen = new Set<string>();
      const top: typeof page.items = [];
      for (const t of page.items) {
        const k = String(t.authorId || t.authorHandle || "").toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k); top.push(t);
        if (top.length >= n) break;
      }
      if (top.length) await fomo.withAvatars(top);
      return {
        symbol: page.symbol,
        items: top.map((t) => ({
          authorHandle: t.authorHandle, authorName: t.authorName, avatar: t.avatar,
          positionUsd: t.positionUsd, positionKind: t.positionKind,
          pnlPct: t.pnlPct, thesis: String(t.thesis || "").slice(0, 240),
        })),
      };
    }
    case "STRIX_FOMO_AVATARS": {
      // Pictures for one page of the thesis feed, asked for as the user pages
      // through rather than all at once — a token can carry 200 theses and only
      // five are ever on screen.
      const handles: string[] = (Array.isArray(msg.handles) ? msg.handles : [])
        .slice(0, 10)
        .map((h: unknown) => String(h));
      const rows = handles.map((h: string) => ({ authorHandle: h, avatar: null as string | null }));
      await fomo.withAvatars(rows as any);
      const avatars: Record<string, string> = {};
      for (const r of rows) if (r.avatar) avatars[r.authorHandle] = r.avatar;
      return { avatars };
    }
    // ── Impulse Thesis (our own community feed) ────────────────────────────
    // The author is the active wallet's EVM address — attached here, never taken
    // from the page. The holder-gate is trusted from the panel (which only shows
    // Write to a holder) and the amount held rides along with the thesis.
    case "STRIX_ITHESIS_LIST": {
      const acct = await activeAccount().catch(() => undefined);
      return await impulse.listTheses(String(msg.ca || ""), msg.chain ? String(msg.chain) : undefined, acct?.address || "");
    }
    case "STRIX_ITHESIS_PROFILE": {
      const acct = await activeAccount().catch(() => undefined);
      if (!acct?.address) return { wallet: null, profile: null };
      const r = await impulse.getProfile(acct.address);
      return { wallet: acct.address, profile: "v" in r ? r.v : null };
    }
    case "STRIX_ITHESIS_SETPROFILE": {
      const acct = await activeAccount().catch(() => undefined);
      if (!acct?.address) return { error: "No wallet — create or unlock one first." };
      return await impulse.setProfile(acct.address, String(msg.username || ""), msg.dp ?? null);
    }
    case "STRIX_ITHESIS_WRITE": {
      const acct = await activeAccount().catch(() => undefined);
      if (!acct?.address) return { error: "No wallet — create or unlock one first." };
      const holdingAmount = Number(msg.holdingAmount) || 0;
      if (holdingAmount <= 0) return { error: "You must hold the token to write a thesis." };
      return await impulse.writeThesis({
        wallet: acct.address,
        tokenAddress: String(msg.ca || ""),
        chain: String(msg.chain || ""),
        text: String(msg.text || ""),
        holdingAmount,
        holdingUsd: Number(msg.holdingUsd) || null,
      });
    }

    case "STRIX_ISTATS":
      return await impulse.stats(String(msg.ca || ""));
    case "STRIX_ITRACK":
      return await impulse.track(String(msg.ca || ""), msg.kind === "open" ? "open" : "seen");
    case "STRIX_ILOG": {
      // A completed trade, logged for the profit leaderboard. Author = the
      // active wallet, attached here; the panel supplies size + price.
      const acct = await activeAccount().catch(() => undefined);
      if (!acct?.address) return { ok: false };
      return await impulse.logTrade({
        wallet: acct.address,
        ca: String(msg.ca || ""),
        chain: String(msg.chain || ""),
        symbol: String(msg.symbol || ""),
        side: msg.side === "sell" ? "sell" : "buy",
        tokenAmount: Number(msg.tokenAmount) || 0,
        priceUsd: Number(msg.priceUsd) || 0,
        usdValue: Number(msg.usdValue) || 0,
      });
    }
    case "STRIX_ILEADERBOARD":
      return await impulse.leaderboard(String(msg.window || "all"));

    case "STRIX_ITRENDING":
      return await impulse.trending();

    case "STRIX_TRADER": {
      // X handle -> trading profile on FOMO and pump.fun. Proxied because both
      // hosts refuse a cross-origin call from the page.
      const h = String(msg.handle || "").replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
      // `deep` is only set when the user actually opens the panel. The check
      // that decides whether to show the button stays on the cheap path.
      // `backendOnly` (timeline author lookups) skips pump.fun + the paid
      // FomoScan fallback so non-traders cost nothing beyond one backend call.
      return await traderForX(h, Boolean(msg.deep), Boolean(msg.backendOnly));
    }
    case "STRIX_TOPFOLLOWERS": {
      // A profile's biggest ("notable") followers — verified followers ranked by
      // their own follower count, from twitterapi.io via the backend.
      const h = String(msg.handle || "").replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
      const r = await topFollowers(h);
      return "v" in r ? r.v : null;
    }
    case "STRIX_CASHTAG_TWEETS": {
      // Big accounts tweeting a cashtag, ranked by following, via the backend.
      const sym = String(msg.symbol || "").replace(/^\$/, "");
      if (!/^[A-Za-z0-9_]{1,20}$/.test(sym)) return null;
      const r = await cashtagTweets(sym);
      return "v" in r ? r.v : null;
    }
    case "STRIX_MARKET": {
      // Market Insights — trench score, launchpads, chains from tehcscreener
      // (keyless, CORS-open, updated daily). Cached 30m per window.
      const win = ["1d", "7d", "30d", "all"].includes(String(msg.window)) ? String(msg.window) : "7d";
      return await marketInsights(win);
    }
    case "STRIX_VET": {
      // Account vetting — legit-check signals + score for an X profile.
      const h = String(msg.handle || "").replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return null;
      const r = await vetAccount(h);
      return "v" in r ? r.v : null;
    }
    case "STRIX_QUOTE": {
      // A dry run of the buy: what you would receive, and whether the trade
      // would be refused. buildBuy already computes the expected output on
      // every venue and runs the exit proof, so quoting through it means the
      // ticket shows the same number the swap will use — and a blocked trade
      // says so before the user commits rather than after.
      try {
        const acc = await activeAccount();
        if (!acc) return { error: "locked" };
        const chain: ChainKey = msg.chain || (await resolveTokenChain(String(msg.ca)))?.cfg.key || "robinhood";
        if (CHAINS[chain]?.vm === "svm") return { unsupported: true };
        const b = await api.buildBuy({
          ca: String(msg.ca), amountEth: String(msg.amount),
          address: acc.address, chain,
        });
        return { expectedOut: b.expectedOut || "0", venue: b.venue || "", chain };
      } catch (e: any) {
        return { error: String(e?.message || e).slice(0, 220) };
      }
    }
    case "STRIX_GMGN": {
      // GMGN data proxy for the X panel (content scripts can't fetch cross-origin).
      if (!(await hasGmgnKey())) return { noKey: true };
      try {
        if (msg.what === "security") return { data: await gmgn.security(msg.ca) };
        if (msg.what === "info") return { data: await gmgn.info(msg.ca) };
        if (msg.what === "holders") {
          const fn = msg.tab === "traders" ? gmgn.topTraders : gmgn.topHolders;
          return { data: await fn(msg.ca, msg.orderBy || "amount_percentage", msg.tag || undefined) };
        }
        return { error: "unknown gmgn call" };
      } catch (e: any) {
        return { error: (e?.message || String(e)).slice(0, 140) };
      }
    }
    case "STRIX_STATUS": {
      const acc = await activeAccount();
      const kp = await getUnlockedSol();
      // Either key counts as unlocked: a Solana-only account has no EVM pk and
      // was reporting "locked" in the overlay while perfectly usable.
      if (!acc || (!(await getUnlockedPk()) && !kp)) return { unlocked: false };
      // Balance for the chain the panel is on, not Robinhood. The footer sat
      // under a Buy button, so showing another chain's balance read as
      // spendable funds that were not there.
      const chain: ChainKey = msg.chain || "robinhood";
      const cfg = CHAINS[chain];
      let eth = "0";
      try {
        eth = cfg.vm === "svm"
          ? (kp ? (Number(await sol.solBalance(kp.address)) / 1e9).toString() : "0")
          : formatEther(await nativeBalance(acc.address, chain));
      } catch { /* rpc */ }
      return {
        unlocked: true,
        address: cfg.vm === "svm" ? kp?.address ?? acc.address : acc.address,
        label: acc.label,
        eth,
        symbol: cfg.nativeSymbol,
      };
    }
    case "STRIX_HOLDING": {
      const acc = await activeAccount();
      if (!acc) return { amount: 0 };
      try {
        const chain: ChainKey = msg.chain || "robinhood";
        const info = await api.tokenInfo(msg.ca, chain);
        // getAddress() rejects a base58 mint, so Solana reads its balance from
        // the token account instead of an ERC20 call.
        if (CHAINS[chain]?.vm === "svm") {
          const kp = await getUnlockedSol();
          if (!kp) return { amount: 0 };
          const { raw: solRaw, decimals } = await sol.splBalance(kp.address, String(msg.ca));
          return { amount: formatUnitsNum(solRaw, decimals || info.decimals), decimals: decimals || info.decimals, symbol: info.symbol };
        }
        const raw = await tokenBalance(getAddress(msg.ca), acc.address, chain);
        return { amount: formatUnitsNum(raw, info.decimals), decimals: info.decimals, symbol: info.symbol };
      } catch { return { amount: 0 }; }
    }
    case "STRIX_IMAGE": {
      try {
        if (!msg.url) return { data: null };
        // Same two rules as avatars: the URL comes from a token's metadata and
        // the Content-Type from whoever serves it, so neither is trusted. A
        // header of `image/png" onerror="…` would otherwise close the src
        // attribute the data URI is written into.
        let iu: URL;
        try { iu = new URL(String(msg.url)); } catch { return { data: null }; }
        if (iu.protocol !== "https:") return { data: null };
        if (!IMAGE_HOSTS.has(iu.hostname)) return { data: null };
        const r = await fetch(iu.toString());
        if (!r.ok) return { data: null };
        const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!/^image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)$/.test(ct)) return { data: null };
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        return { data: `data:${ct};base64,${btoa(bin)}` };
      } catch { return { data: null }; }
    }
    case "STRIX_BUY": {
      await requireUnlocked();
      const acc = await activeAccount();
      // A Solana-key account has no EVM pk, so the lock check is "is anything
      // unlocked", with the per-chain key fetched where it is actually used.
      if (!acc || (!(await getUnlockedPk()) && !(await getUnlockedSol()))) return { error: "locked" };
      const chain: ChainKey = msg.chain || (await resolveTokenChain(String(msg.ca)))?.cfg.key || "robinhood";
      // Solana has no bundle to sign: PumpPortal and Jupiter hand back a
      // finished transaction, and the key is ed25519 rather than the EVM one.
      if (CHAINS[chain]?.vm === "svm") {
        const kp = await getUnlockedSol();
        if (!kp) return { error: "This account has no Solana key." };
        const r = await sol.solBuy(kp, String(msg.ca), Number(msg.amountEth), msg.slippage ?? 10);
        await sol.confirmTx(r.signature).catch(() => false);
        try {
          const info = await api.tokenInfo(msg.ca, chain);
          await addToken(msg.ca, "trade", { symbol: info.symbol, name: info.name, decimals: info.decimals }, chain);
        } catch { /* non-fatal */ }
        return { hash: r.signature, chain, via: r.via };
      }
      const bundle = await api.buildBuy({ ca: msg.ca, amountEth: String(msg.amountEth), address: acc.address, slippage: msg.slippage ?? 10, chain });
      let hash: string | undefined;
      // Sign on the chain the bundle was built for, never the wallet default.
      for (const tx of bundle.txs) {
        hash = await signAndSend(tx, chain);
        await waitReceipt(hash as `0x${string}`, chain);
      }
      try {
        const info = await api.tokenInfo(msg.ca, chain);
        await addToken(msg.ca, "trade", { symbol: info.symbol, name: info.name, decimals: info.decimals }, chain);
      } catch { /* non-fatal */ }
      return { hash };
    }
    case "STRIX_SELL": {
      await requireUnlocked();
      const acc = await activeAccount();
      if (!acc || (!(await getUnlockedPk()) && !(await getUnlockedSol()))) return { error: "locked" };
      const chain: ChainKey = msg.chain || (await resolveTokenChain(String(msg.ca)))?.cfg.key || "robinhood";
      if (CHAINS[chain]?.vm === "svm") {
        const kp = await getUnlockedSol();
        if (!kp) return { error: "This account has no Solana key." };
        const r = await sol.solSell(kp, String(msg.ca), msg.pct, msg.slippage ?? 10);
        await sol.confirmTx(r.signature).catch(() => false);
        if (msg.pct >= 100) {
          const { raw } = await sol.splBalance(kp.address, String(msg.ca)).catch(() => ({ raw: 1n }));
          await untrackIfEmpty(msg.ca, chain, raw).catch(() => false);
        }
        return { hash: r.signature, chain, via: r.via };
      }
      const bundle = await api.buildSell({ ca: msg.ca, pct: msg.pct, address: acc.address, slippage: msg.slippage ?? 10, chain });
      let hash: string | undefined;
      for (const tx of bundle.txs) {
        hash = await signAndSend(tx, chain);
        await waitReceipt(hash as `0x${string}`, chain);
      }
      // Sold out: stop listing it. Balance is re-read rather than assumed.
      if (msg.pct >= 100) {
        const left = await tokenBalance(getAddress(msg.ca), acc.address, chain).catch(() => 1n);
        await untrackIfEmpty(msg.ca, chain, left).catch(() => false);
      }
      return { hash, chain };
    }
    default:
      return { error: "unknown" };
  }
}

/**
 * Enforce auto-lock on the paths that spend money.
 *
 * The idle check lived only in the popup's reload(), so it ran when the popup
 * opened. Trades started from the injected panel never open the popup, which
 * meant a user who set "lock after 15 minutes" and walked away still had a
 * usable session key hours later. The setting has to be enforced where signing
 * happens, not where the UI happens.
 */
async function requireUnlocked(): Promise<void> {
  if (await isIdleExpired()) {
    await lockWallet();
    throw new Error("Wallet locked after inactivity. Open Impulse and unlock to continue.");
  }
  await touchActivity();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own contexts may drive the wallet. A page cannot reach this today
  // (no externally_connectable), but these handlers sign and broadcast real
  // transactions, so the origin check is stated rather than assumed.
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: "unauthorized" });
    return false;
  }
  handle(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: (e?.shortMessage || e?.message || String(e)).slice(0, 160) }));
  return true; // keep the channel open for the async response
});
