// Resolve an X handle to a trader, across FOMO and pump.fun.
//
// Both are looked up by the X handle itself, which is how people actually name
// themselves across these platforms. The catch is that name equality is not
// proof: @unipcs on X and "unipcs" on FOMO could be different people, and
// showing one person's positions on another's profile would be a serious thing
// to get wrong.
//
// So the match is graded rather than assumed. When the trading account itself
// names the X handle — pump.fun's `x_username`, FomoScan's `twitter` — that is
// a link the account asserted about itself, and it is reported as confirmed.
// When only the handles happen to be spelled the same, the data is still shown,
// labelled as a name match so the reader can weigh it. What is never done is
// presenting the second case as though it were the first.
//
// Everything on the FOMO side now comes from FomoScan. api.fomoapi.io, which
// used to serve the holdings, the trade list and the live socket, began
// answering 401 on every endpoint — so those three lists were empty for every
// trader, not merely for the ones it did not know. FomoScan has no balances or
// per-trade endpoint either, but /v2/thesis/user/{id} carries a position
// snapshot on every record: token, holdings in USD, realised and unrealised
// PnL. That is the same material, arranged by thesis rather than by fill.

import { fsGet, inlineAvatar, type FsResult } from "./fomoscan";
import { userByHandle, userBalances, userSwaps } from "./fomoBackend";

const PUMP = "https://frontend-api-v3.pump.fun";

/**
 * Identity is cached for six hours, PnL for four, activity for one.
 *
 * All long on purpose. A profile costs 5,250 CU to build — /v2/user/handle and
 * its /pnl sibling are 2,500 each, charged even on a 404, plus 250 a page of
 * activity — against a 250,000 CU monthly allowance shared by every user of the
 * extension. The PnL itself comes from a once-daily on-chain sweep, so re-asking
 * inside four hours cannot return anything new; the cache is not merely thrift,
 * it matches how often the numbers actually change.
 */
const IDENT_TTL = 6 * 60 * 60_000;
const PNL_TTL = 4 * 60 * 60_000;
const ACT_TTL = 60 * 60_000;

/** Pages of activity to walk. 20 records each, 250 CU each. */
const ACT_PAGES = 3;

export type Trade = {
  id: string;
  symbol: string;
  address: string | null;
  /** "open" or "closed". Decides which PnL figure is the live one. */
  status: string;
  amount: number | null;
  /** Realised for a closed position, unrealised for an open one. */
  pnlUsd: number | null;
  /** Return on the position as a percentage, on the same basis as pnlUsd. */
  pnlPct: number | null;
  /** What they wrote when they took it. This feed is theses, so there is one. */
  note: string;
  createdAt: number | null;
  closedAt: number | null;
  chain: string | null;
};

export type Holding = {
  symbol: string;
  address: string | null;
  valueUsd: number | null;
  amount: number | null;
  /** Unrealised return on the position. NOT a 24h move — the source has no
   *  such figure, and labelling it as one would invent a timeframe. */
  returnPct: number | null;
  chain: string | null;
};

/** How firmly this profile is tied to the X handle on screen. */
export type Link = "confirmed" | "name";

export type FomoSide = {
  handle: string;
  displayName: string | null;
  bio: string | null;
  avatar: string | null;
  followers: number | null;
  verified: boolean;
  link: Link;
  wallets: { solana: string | null; evm: string | null };
  pnl: { "24h": number | null; "7d": number | null; "30d": number | null; all: number | null } | null;
  tradeCount: number | null;
  volumeUsd: number | null;
  avgHoldSeconds: number | null;
  accountAgeDays: number | null;
  /** Share of trades closed in profit, 0–1, over the window below. */
  winRate: number | null;
  uniqueTokens: number | null;
  rank: number | null;
  walletsRanked: number | null;
  /** Which window the stats above describe. Stated because it is a window, not
   *  a lifetime, and labelling it "Trades" alone would overstate it. */
  statWindow: string | null;
  /**
   * Open positions, one row per token.
   *
   * These are positions attached to something they wrote, not a wallet scan —
   * a token they hold and never posted about does not appear. That is a
   * narrower claim than "portfolio" and the panel says so.
   */
  holdings: Holding[];
  /** Summed from holdings. */
  portfolioUsd: number | null;
  /** Position history, newest first — every record, including repeats on the
   *  same token, because each one is a separate statement at a separate time. */
  trades: Trade[];
  /** True when the history runs deeper than the pages we walked. */
  moreTrades: boolean;
  /** False while only the cheap identity call has been made — the stats and
   *  the two lists are not loaded yet. */
  deep: boolean;
  /** Set when FomoScan refused on credits, so the panel can say so instead of
   *  rendering a profile with every figure blank. */
  quotaError: string | null;
};

export type PumpSide = {
  handle: string;
  bio: string | null;
  avatar: string | null;
  followers: number | null;
  following: number | null;
  link: Link;
  wallets: { solana: string | null; evm: string | null };
};

export type Trader = {
  xHandle: string;
  fomo: FomoSide | null;
  pump: PumpSide | null;
};

const TTL = 5 * 60_000;
const cache = new Map<string, { t: number; v: Trader | null }>();

const num = (x: any): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const eq = (a: any, b: any) =>
  String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/** Chains as FomoScan names them. Unknown stays null rather than guessing. */
/** Quote/stable tokens across FOMO's chains. A swap against one of these is a
 *  buy or a sell of the OTHER leg; the stable side is never the "traded" token. */
const STABLES = new Set<string>([
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG (Robinhood)
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC (eth)
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC (base)
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC (bnb)
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT (eth)
  "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v", // USDC (solana)
]);
const isStable = (a: any) => STABLES.has(String(a || "").toLowerCase());

/** networkId (number) → our chain key, for the FOMO-direct path. */
const NET_ID_TO_CHAIN: Record<number, string> = {
  4663: "robinhood", 8453: "base", 1: "eth", 56: "bnb", 1399811149: "solana",
};

const NETWORK_TO_CHAIN: Record<string, string> = {
  sol: "solana", solana: "solana", eth: "eth", ethereum: "eth",
  base: "base", bsc: "bnb", bnb: "bnb", robinhood: "robinhood", rh: "robinhood",
};

const jget = async (url: string): Promise<any | null> => {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

/**
 * Positions and history for one trader, from their thesis feed.
 *
 * The feed is newest-first and a trader writes about the same token repeatedly,
 * so it carries several snapshots of one position: unipcs has three USELESS
 * records in a single page. The history keeps them all — each is a separate
 * statement made at a separate time — but the positions list keeps only the
 * newest per token. Listing all three would show one holding three times and
 * treble it in the portfolio total.
 */
async function fomoscanActivity(id: string): Promise<{ holdings: Holding[]; trades: Trade[]; more: boolean }> {
  const raw: any[] = [];
  let before: string | null = null;
  let more = false;

  for (let page = 0; page < ACT_PAGES; page++) {
    const path: string = `/v2/thesis/user/${encodeURIComponent(id)}` +
      (before ? `?before=${encodeURIComponent(before)}` : "");
    const r = await fsGet<any>(path, { ttl: ACT_TTL, negTtl: 10 * 60_000, cost: 250 });
    if ("error" in r || !r.v) break;
    raw.push(...((r.v.items || []) as any[]));
    more = Boolean(r.v.hasMore);
    if (!r.v.hasMore || !r.v.nextBefore) break;
    before = String(r.v.nextBefore);
  }

  const trades: Trade[] = raw.map((t, i) => {
    const closed = t.closedAt != null;
    return {
      id: String(t.id || i),
      symbol: String(t.tokenSymbol || "?"),
      address: t.tokenAddress ? String(t.tokenAddress) : null,
      status: closed ? "closed" : "open",
      amount: num(t.tokenAmount),
      // Only one of the two is meaningful at a time, so the row shows that one
      // rather than making the reader work out which applies.
      pnlUsd: closed ? num(t.realizedPnlUsd) : num(t.unrealizedPnlUsd),
      pnlPct: closed ? num(t.percentageRealizedPnl) : num(t.percentageUnrealizedPnl),
      note: String(t.thesis || ""),
      createdAt: num(t.fomoCreatedAt),
      closedAt: num(t.closedAt),
      chain: NETWORK_TO_CHAIN[String(t.tokenNetwork || "").toLowerCase()] ?? null,
    };
  });

  const seen = new Set<string>();
  const holdings: Holding[] = [];
  for (const t of raw) {
    const addr = t.tokenAddress ? String(t.tokenAddress) : null;
    const key = (addr || String(t.tokenSymbol || "")).toLowerCase();
    if (!key || seen.has(key)) continue;   // newest wins: the feed is newest-first
    seen.add(key);
    const v = num(t.holdingsUsd);
    if (!v || v <= 0) continue;            // closed out, or never captured
    holdings.push({
      symbol: String(t.tokenSymbol || "?"),
      address: addr,
      valueUsd: v,
      amount: num(t.tokenAmount),
      returnPct: num(t.percentageUnrealizedPnl),
      chain: NETWORK_TO_CHAIN[String(t.tokenNetwork || "").toLowerCase()] ?? null,
    });
  }
  holdings.sort((a, z) => (z.valueUsd ?? 0) - (a.valueUsd ?? 0));

  return { holdings, trades, more };
}

/**
 * The FOMO half of a profile.
 *
 * A 404 from FomoScan is an answer, not a failure — it means no trader by that
 * handle, and the caller renders the pump.fun side alone.
 */
/** A profile we could not load, carrying the reason. Every field the panel
 *  reads is present and empty, so nothing downstream has to special-case it. */
function blankSide(handle: string, why: string): FomoSide {
  return {
    handle, displayName: null, bio: null, avatar: null, followers: null,
    verified: false, link: "name", wallets: { solana: null, evm: null },
    pnl: null, tradeCount: null, volumeUsd: null, avgHoldSeconds: null,
    accountAgeDays: null, winRate: null, uniqueTokens: null, rank: null,
    walletsRanked: null, statWindow: null, holdings: [], portfolioUsd: null,
    trades: [], moreTrades: false, deep: false, quotaError: why,
  };
}

/**
 * The FOMO half of a profile, straight from the user's connected FOMO account.
 *
 * Preferred over FomoScan when a token is connected: it is the live source, and
 * its holdings are richer — 192 tokens with a current price and an entry price
 * each, versus FomoScan's thesis-derived positions. Returns null when no account
 * is connected or the handle is unknown to FOMO, so the caller falls through to
 * FomoScan cleanly.
 *
 * FOMO exposes no windowed PnL (its /pnl 404s), so the window figures are left
 * null; the panel leans on the portfolio value and per-holding return instead.
 */
/**
 * Resolve an X handle to a FOMO user, allowing for the ways the two platforms
 * spell the same person: FOMO carries no twitter link for most accounts, so an
 * exact-handle lookup misses @theunipcs → "unipcs". A short list of common
 * transforms (a "the"/"real"/"official" prefix, trailing digits, underscores)
 * bridges the frequent cases. A hit through a variation is still shown as a
 * name match, never a confirmed link, so a wrong guess is labelled as a guess.
 */
async function resolveFomoUser(handle: string): Promise<any | null> {
  const tryOne = async (h: string): Promise<any | null> => {
    const r = await userByHandle(h);
    return !("error" in r) && r.v && r.v.id ? r.v : null;
  };
  const exact = await tryOne(handle);
  if (exact) return exact;

  const h = handle.toLowerCase();
  const variants = new Set<string>();
  for (const pre of ["the", "real", "official", "its", "iam"]) if (h.startsWith(pre)) variants.add(h.slice(pre.length));
  if (h.endsWith("official")) variants.add(h.slice(0, -"official".length));
  variants.add(h.replace(/_/g, ""));
  variants.add(h.replace(/\d+$/, ""));
  for (const v of variants) {
    if (v && v !== h && v.length >= 3) { const u = await tryOne(v); if (u) return u; }
  }
  return null;
}

/**
 * X handle → FOMO handle, for the few accounts that spell themselves differently
 * on the two platforms. Explicit rather than fuzzy: a "strip the prefix" rule
 * would attach the wrong person to a lookalike handle. Add entries here as they
 * come up; anything not listed is looked up as-is.
 */
const HANDLE_ALIASES: Record<string, string> = {
  theunipcs: "unipcs",
};

async function fomoSideDirect(x: string, deep: boolean): Promise<FomoSide | null> {
  const p = await resolveFomoUser(x);
  if (!p) return null;

  const tw = p.twitter;
  const link: Link = tw && (eq(tw, x) || eq(String(tw).split("/").pop(), x)) ? "confirmed" : "name";
  const created = p.createdAt ? Date.parse(p.createdAt) : NaN;

  let holdings: Holding[] = [];
  let trades: Trade[] = [];
  let moreTrades = false;
  let portfolioUsd: number | null = null;
  let unrealized = 0;
  let realizedPnl = 0;

  if (deep) {
    const [bal, sw] = await Promise.all([
      userBalances(String(p.id)).catch(() => null),
      userSwaps(String(p.id)).catch(() => null),
    ]);

    if (bal && "v" in bal && bal.v) {
      for (const it of (bal.v.balances || []) as any[]) {
        const tfr = it.tokenFilterResult || {};
        const tok = tfr.token || {};
        const qty = num(it.balance?.shiftedBalance) ?? 0;
        const price = num(tfr.priceUSD) ?? 0;
        const value = qty * price;
        if (value <= 0) continue;
        const at = it.activeTrade || {};
        // Cost basis from the average entry price the trade tracks.
        const entryQty = num(at.humanTokenAmount) ?? qty;
        const cost = entryQty * (num(at.avgEntryPrice) ?? 0);
        const returnPct = cost > 0 ? ((value - cost) / cost) * 100 : null;
        holdings.push({
          symbol: String(tok.symbol || "?"),
          address: it.balance?.tokenAddress ? String(it.balance.tokenAddress) : null,
          valueUsd: value,
          amount: qty,
          returnPct,
          chain: NET_ID_TO_CHAIN[Number(tok.networkId)] ?? null,
        });
        if (cost > 0) unrealized += value - cost;
      }
      holdings.sort((a, z) => (z.valueUsd ?? 0) - (a.valueUsd ?? 0));
      const sum = holdings.reduce((n, h) => n + (h.valueUsd ?? 0), 0);
      portfolioUsd = sum > 0 ? sum : null;
      // Realised PnL FOMO has already summed across closed positions.
      realizedPnl = num(bal.v.otherPnl) ?? 0;
    }

    if (sw && "v" in sw && sw.v) {
      const rows = (sw.v.swaps || []) as any[];
      moreTrades = Boolean(sw.v.hasNextPage);
      trades = rows.slice(0, 40).map((r, i) => {
        // A swap trades one token against a stable. Which leg is the stable
        // tells buy from sell; the other leg is the token that matters, and the
        // USD value is the size. FOMO carries no per-swap PnL, so the row shows
        // the trade itself — direction, token, size, time — not a blank "—".
        const inStable = isStable(r.inTokenAddress);
        const outStable = isStable(r.outTokenAddress);
        const buy = inStable && !outStable;              // paid stable, got token
        const sell = outStable && !inStable;             // gave token, got stable
        const tokAddr = buy ? r.outTokenAddress : sell ? r.inTokenAddress : r.outTokenAddress;
        const sym = symbolFor(holdings, tokAddr);
        return {
          id: String(r.id || i),
          symbol: sym || (tokAddr ? `${String(tokAddr).slice(0, 6)}…` : "swap"),
          address: tokAddr ? String(tokAddr) : null,
          // status doubles as the direction label for the row.
          status: buy ? "buy" : sell ? "sell" : "swap",
          amount: num(r.humanUsdAmountOut) ?? num(r.humanUsdAmountIn),
          pnlUsd: null,
          pnlPct: null,
          note: "",
          createdAt: r.createdAt ? Date.parse(r.createdAt) || null : null,
          closedAt: null,
          chain: NET_ID_TO_CHAIN[Number(r.networkId)] ?? null,
        };
      });
    }
  }

  // Realised (FOMO's own sum) plus the unrealised we computed from live prices.
  // No per-window split exists, so the total goes in "all".
  const totalPnl = deep && portfolioUsd != null ? unrealized + realizedPnl : null;

  return {
    handle: String(p.userHandle || x),
    displayName: p.displayName ? String(p.displayName) : null,
    bio: p.description ? String(p.description) : null,
    avatar: await inlineAvatar(p.profilePictureLink || null),
    followers: num(p.followers),
    verified: Boolean(p.verified),
    link,
    wallets: {
      solana: p.address ? String(p.address) : null,
      evm: p.evmAddress ? String(p.evmAddress) : null,
    },
    pnl: totalPnl != null ? { "24h": null, "7d": null, "30d": null, all: totalPnl } : null,
    tradeCount: num(p.numTrades),
    volumeUsd: num(p.totalVolume),
    avgHoldSeconds: num(p.averageHoldTimeSeconds),
    accountAgeDays: isFinite(created) ? Math.max(0, (Date.now() - created) / 86_400_000) : null,
    winRate: null,
    uniqueTokens: deep ? holdings.length : num(p.swapCount),
    rank: null,
    walletsRanked: null,
    statWindow: null,
    holdings,
    portfolioUsd,
    trades,
    moreTrades,
    deep,
    quotaError: null,
  };
}

/** Symbol of a held token by address, for labelling swaps that only carry
 *  addresses. Returns null when the token is not among current holdings. */
function symbolFor(holdings: Holding[], addr: any): string | null {
  if (!addr) return null;
  const a = String(addr).toLowerCase();
  const h = holdings.find((x) => (x.address || "").toLowerCase() === a);
  return h ? h.symbol : null;
}

async function fomoSide(x: string, deep: boolean): Promise<FomoSide | null> {
  const [uR, pR] = await Promise.all([
    fsGet<any>(`/v2/user/handle/${encodeURIComponent(x)}`, { ttl: IDENT_TTL, negTtl: 60 * 60_000, cost: 2500 }),
    deep
      ? fsGet<any>(`/v2/user/handle/${encodeURIComponent(x)}/pnl`, { ttl: PNL_TTL, negTtl: 60 * 60_000, cost: 2500 })
      : Promise.resolve({ v: null } as FsResult<any>),
  ]);
  const u = "error" in uR ? null : uR.v;
  const pn = "error" in pR ? null : pR.v;
  // A quota refusal is not the same answer as "we do not know them", and the
  // panel must be able to tell the reader which one happened.
  const quota = ("error" in uR && uR.error) || ("error" in pR && pR.error) || null;
  // When credits are the reason we know nothing, say so through a properly
  // shaped record rather than a bare `{quotaError}` cast. Consumers read
  // `holdings.length` and `pnl["30d"]`; handing them an object missing those
  // fields turns a billing problem into a crash in the panel.
  if (!u && !pn) return quota ? blankSide(x, String(quota)) : null;

  const handle = String(u?.handle || pn?.handle || x);

  // The X link, graded rather than assumed. FomoScan carries a `twitter` field
  // the account asserted about itself — as a full URL — and when it names the
  // handle on screen that is a confirmed link. It is populated on roughly one
  // account in twenty, so most profiles resolve to a name match, which is shown
  // and labelled as such rather than dressed up as verification.
  const tw = u?.twitter || pn?.twitter;
  const link: Link =
    tw && (eq(tw, x) || eq(String(tw).split("/").pop(), x)) ? "confirmed" : "name";

  // The sweep reports 24h, 7d and 30d. 30d is the headline window because the
  // shorter two are noise on anyone who does not trade daily.
  const win = pn?.windows || {};
  const d30 = win["30d"] || {};
  const firstSeen = num(d30.walletFirstSeenAt) ?? num(win["7d"]?.walletFirstSeenAt);

  // Activity needs the user id, which only the identity record carries.
  const act = deep && u?.id
    ? await fomoscanActivity(String(u.id))
    : { holdings: [] as Holding[], trades: [] as Trade[], more: false };
  const sum = act.holdings.reduce((n, h) => n + (h.valueUsd ?? 0), 0);

  return {
    handle,
    displayName: (u?.name || pn?.displayName) ? String(u?.name || pn?.displayName) : null,
    bio: u?.bio ? String(u.bio) : null,
    avatar: await inlineAvatar(u?.profilePicture || pn?.avatarUrl || null),
    followers: num(pn?.followers),
    // FomoScan publishes no verification flag. Reported as unverified rather
    // than guessed, so the tick never appears on an assumption.
    verified: false,
    link,
    wallets: {
      solana: u?.solanaAddress ? String(u.solanaAddress) : null,
      // /pnl reports the single wallet it measured, which fills the gap when
      // the identity record is the one that 404d.
      evm: u?.evmAddress ? String(u.evmAddress)
        : (pn?.wallet && String(pn.wallet).startsWith("0x") ? String(pn.wallet) : null),
    },
    // No all-time window exists in the sweep. Left null rather than summed from
    // three overlapping windows, which would count the same trade three times.
    pnl: pn?.windows
      ? { "24h": num(win["24h"]?.pnlUsd), "7d": num(win["7d"]?.pnlUsd), "30d": num(d30.pnlUsd), all: null }
      : null,
    tradeCount: num(d30.trades),
    volumeUsd: num(d30.volumeUsd),
    avgHoldSeconds: num(d30.avgHoldSeconds),
    accountAgeDays: firstSeen ? Math.max(0, (Date.now() - firstSeen) / 86_400_000) : null,
    winRate: num(d30.winRate),
    uniqueTokens: num(d30.uniqueTokens),
    // Documented on the endpoint but absent from live responses, so read
    // defensively rather than relied on.
    rank: num(pn?.rank) ?? num(d30.rank),
    walletsRanked: num(pn?.walletsRanked),
    statWindow: pn?.windows ? "30d" : null,
    holdings: act.holdings,
    portfolioUsd: sum > 0 ? sum : null,
    trades: act.trades,
    moreTrades: act.more,
    deep,
    quotaError: quota ? String(quota) : null,
  };
}

async function pumpSide(x: string): Promise<PumpSide | null> {
  const p = await jget(`${PUMP}/users/${encodeURIComponent(x)}`);
  if (!p || !p.username) return null;
  return {
    handle: String(p.username),
    bio: p.bio ? String(p.bio) : null,
    avatar: await inlineAvatar(p.profile_image || null),
    followers: num(p.followers),
    following: num(p.following),
    link: eq(p.x_username, x) ? "confirmed" : "name",
    wallets: {
      solana: p.canonical_svm_wallet ? String(p.canonical_svm_wallet) : null,
      evm: p.canonical_evm_wallet ? String(p.canonical_evm_wallet) : null,
    },
  };
}

/** Both platforms, looked up by the X handle. Null when neither knows them. */
/**
 * Both platforms, looked up by the X handle.
 *
 * `deep` is the difference between deciding whether to show a button and
 * filling the panel behind it. The shallow form costs one 2,500 CU identity
 * call; the deep form adds the PnL sweep and three pages of activity, another
 * 3,250. Since the check runs on EVERY X profile the user opens, whether or
 * not they asked, buying the panel up front spent the monthly allowance on
 * profiles nobody looked at. Now the panel is bought when it is opened.
 */
export async function traderForX(xHandle: string, deep = false): Promise<Trader | null> {
  const key = (deep ? "deep:" : "") + xHandle.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  // Our backend is the primary source for the FOMO side. FomoScan is only a
  // fallback for when the backend can't answer (unreachable or walled), so a
  // handle the backend resolves never pays a FomoScan credit.
  const [direct, pump] = await Promise.all([
    fomoSideDirect(xHandle, deep).catch(() => null),
    pumpSide(xHandle).catch(() => null),
  ]);
  const fomo = direct ?? (await fomoSide(xHandle, deep).catch(() => null));
  const out: Trader | null = fomo || pump ? { xHandle, fomo, pump } : null;
  cache.set(key, { t: Date.now(), v: out });
  return out;
}
