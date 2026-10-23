// Trader "thesis" posts, keyed by token — now served by FomoScan.
//
// A thesis is what a trader wrote about a position, and it arrives with the
// position attached: how much they hold in USD, and their running profit. That
// pairing is the whole reason it is worth showing — an opinion next to the size
// of the bet behind it.
//
// Moved off api.fomoapi.io because that source did not know most of the people
// being looked up. FomoScan costs 250 CU a page against a metered key; see the
// header of fomoscan.ts before adding a call.

import { fsGet, inlineAvatar } from "./fomoscan";
import { thesisForToken } from "./fomoBackend";

/** Chain ids as FomoScan reports them, mapped to our own keys. An unrecognised
 *  network stays null so the chain filter below keeps the row rather than
 *  silently dropping a token whose network we have not seen yet. */
const NETWORK_TO_CHAIN: Record<string, string> = {
  sol: "solana",
  solana: "solana",
  eth: "eth",
  ethereum: "eth",
  base: "base",
  bsc: "bnb",
  bnb: "bnb",
  robinhood: "robinhood",
  rh: "robinhood",
};

export type Thesis = {
  id: string;
  thesis: string;
  /** Handle AS IT WAS when the thesis was posted. Traders rename, so this can
   *  be stale — never present it as a verified or current identity. */
  authorHandle: string;
  authorName: string;
  authorId: string;
  authorIsDev: boolean;
  /** Profile picture as a data: URI, or null. See inlineAvatar in fomoscan.ts
   *  for why it is inlined rather than linked. */
  avatar: string | null;
  /** Remote avatar URL when the source hands one per item (FOMO does). Inlined
   *  by withAvatars for the visible rows; null when the source has none. */
  avatarUrl?: string | null;
  /** Current holdings in USD. Frequently 0 — see positionUsd. */
  holdingsUsd: number | null;
  /** Size of the trade in USD. Populated on many records where equity is not. */
  tradeUsd: number | null;
  /**
   * The money behind the words, and the ranking signal.
   *
   * Holdings alone is not it. On a sampled token 67 of 85 theses carried
   * holdings 0 while reporting six- and seven-figure trades and PnL — so a 0
   * there means "holdings not captured", not "sold out". Ranking on it buried
   * the single most-endorsed thesis on the token, from a trader with a $1.2M
   * position, on page 14 of 17. Falls back to tradeUsd, and stays null when
   * neither is known rather than pretending that is zero.
   */
  positionUsd: number | null;
  /** Which field positionUsd came from, so the row can say the right word. */
  positionKind: "held" | "traded" | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** Running return on the position, as a percentage. */
  pnlPct: number | null;
  likeCount: number;
  /** FomoScan does not carry reply counts. Always 0; the row hides it. */
  replyCount: number;
  createdAt: number | null;
  chain: string | null;
};

export type ThesisPage = {
  items: Thesis[];
  count: number;
  symbol: string | null;
  chain: string | null;
};

/**
 * Cached for half an hour, on disk.
 *
 * Long because the feed is additive — a thesis posted in the last ten minutes
 * changes the tail of a list ranked by position size, not its head — and
 * because a shorter window spends the monthly allowance on re-reading pages
 * nobody scrolled.
 */
const TTL = 30 * 60_000;

/**
 * How deep to walk the feed.
 *
 * FomoScan returns 25 theses a page, newest first, and the panel ranks by
 * position size — so the biggest holder on a busy token can sit several pages
 * back, and stopping at one page would quietly turn "ranked by position" into
 * "the largest of the 25 most recent". Four pages is 100 theses for 1,000 CU,
 * which keeps that promise honest on every token sampled while leaving the
 * allowance able to serve a useful number of tokens.
 */
const MAX_PAGES = 4;

const num = (x: any): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/**
 * Percentage return on a position, when FomoScan has not computed one.
 *
 * Equity is what the position is worth NOW, so cost basis is equity minus the
 * unrealised gain — deriving the percentage from equity alone would divide by
 * the wrong number and understate every winner.
 */
function pnlPercent(equity: number | null, tradeUsd: number | null, unrealized: number | null, realized: number | null): number | null {
  const gain = (unrealized ?? 0) + (realized ?? 0);
  if (!gain) return null;
  let basis = equity && equity > 0 ? equity - (unrealized ?? 0) : 0;
  if (basis <= 0 && tradeUsd && tradeUsd > 0) basis = tradeUsd;
  if (basis <= 0) return null;
  return (gain / basis) * 100;
}

function toThesis(raw: any, i: number): Thesis {
  const equity = num(raw.holdingsUsd);
  const trade = num(raw.authorTradeUsd);
  const unreal = num(raw.unrealizedPnlUsd);
  const real = num(raw.realizedPnlUsd);
  const held = equity != null && equity > 0;
  const position = held ? equity : trade && trade > 0 ? trade : null;

  // FomoScan computes both percentages against a proper cost basis, so prefer
  // its number over ours. Which one applies depends on whether the position is
  // still open: an open trade's live return is the unrealised one, a closed
  // trade's is what was actually banked. Adding them would mix two bases.
  const apiPct = held
    ? num(raw.percentageUnrealizedPnl)
    : num(raw.percentageRealizedPnl) ?? num(raw.percentageUnrealizedPnl);

  return {
    id: String(raw.id || `${raw.authorId || raw.authorHandle || i}-${i}`),
    thesis: String(raw.thesis || ""),
    authorHandle: String(raw.authorHandle || ""),
    authorName: String(raw.authorName || raw.authorHandle || ""),
    authorId: String(raw.authorId || raw.authorHandle || ""),
    authorIsDev: Boolean(raw.authorIsDev),
    avatar: null,
    holdingsUsd: equity,
    tradeUsd: trade,
    positionUsd: position,
    positionKind: position == null ? null : held ? "held" : "traded",
    realizedPnlUsd: real,
    unrealizedPnlUsd: unreal,
    pnlPct: apiPct ?? pnlPercent(equity, trade, unreal, real),
    likeCount: Number(raw.likeCount) || 0,
    replyCount: 0,
    createdAt: num(raw.fomoCreatedAt),
    chain: NETWORK_TO_CHAIN[String(raw.tokenNetwork || "").toLowerCase()] ?? null,
  };
}

/* ── avatars ───────────────────────────────────────────────────────────────
   A thesis carries no picture and resolving one per author is out of the
   question: /v2/user/handle costs 2,500 CU a head, so a single five-row page
   would cost more than fifty token lookups. FomoScan's PnL leaderboard returns
   a hundred traders WITH their avatars for 250 CU, so that one call is the
   whole avatar budget. Authors outside the top hundred get the seeded disc,
   which is what the fallback was always for. */

const avatarCache = new Map<string, string | null>();   // handle -> data: URI
const avatarUrls = new Map<string, string>();           // handle -> remote URL
let boardLoaded = false;

async function loadBoardAvatars(): Promise<void> {
  if (boardLoaded) return;
  boardLoaded = true; // set first: one attempt per worker life, even if it fails
  // A day, because the board is a daily on-chain sweep and a face does not move.
  const r = await fsGet<any>("/v2/leaderboard/traders-fomoscan", { ttl: 24 * 60 * 60_000 });
  if ("error" in r || !r.v) return;
  for (const t of (r.v.entries || []) as any[]) {
    const h = String(t.handle || "").toLowerCase();
    if (h && t.avatarUrl) avatarUrls.set(h, String(t.avatarUrl));
  }
}

async function avatarFor(handle: string): Promise<string | null> {
  const h = handle.toLowerCase();
  if (!h) return null;
  if (avatarCache.has(h)) return avatarCache.get(h)!;
  const data = await inlineAvatar(avatarUrls.get(h) || null);
  avatarCache.set(h, data);
  return data;
}

/**
 * Fill in avatars for the authors on one page.
 *
 * Deliberately per-page rather than for the whole list: a token can carry a
 * hundred theses and only five are on screen.
 */
const urlAvatarCache = new Map<string, string | null>();   // avatarUrl -> data URI

export async function withAvatars(items: Thesis[]): Promise<void> {
  await loadBoardAvatars();
  await Promise.all(items.map(async (t) => {
    if (t.avatar) return;
    // A FOMO item carries its own picture URL; the same author recurs across a
    // token's theses, so inline each distinct URL once and reuse it.
    if (t.avatarUrl) {
      if (!urlAvatarCache.has(t.avatarUrl)) urlAvatarCache.set(t.avatarUrl, await inlineAvatar(t.avatarUrl));
      t.avatar = urlAvatarCache.get(t.avatarUrl)!;
      return;
    }
    // A FomoScan item has no per-item URL, so fall back to the leaderboard
    // lookup keyed on the handle.
    t.avatar = await avatarFor(t.authorHandle);
  }));
}

/* ── FOMO backend ───────────────────────────────────────────────────────────
   The feed comes from our own backend (see fomoBackend.ts), which serves the
   real FOMO theses, live, for every user with nothing to connect. The shape is
   FOMO's own, mapped from a captured response: the position and PnL live under
   `authorTrade`, the text under `comment.comment`. */

const NET_TO_CHAIN: Record<number, string> = {
  4663: "robinhood", 8453: "base", 1: "eth", 56: "bnb", 1399811149: "solana",
};

function fromFomo(it: any): Thesis {
  const tr = it.authorTrade || {};
  const closed = tr.closedAt != null;
  // usdValue is the money in the position — FOMO's own equivalent of the
  // ranking signal. equity is often 0 even when usdValue is large, exactly the
  // trap noted on positionUsd, so usdValue leads.
  const pos = num(tr.usdValue);
  return {
    id: String(it.id),
    thesis: String(it.comment?.comment || ""),
    authorHandle: String(it.userHandle || ""),
    authorName: String(it.displayName || it.userHandle || ""),
    authorId: String(it.userId || ""),
    authorIsDev: Boolean(it.isDev),
    avatar: null,
    avatarUrl: it.profilePictureLink ? String(it.profilePictureLink) : null,
    holdingsUsd: num(it.equity),
    tradeUsd: pos,
    positionUsd: pos,
    positionKind: pos == null ? null : closed ? "traded" : "held",
    realizedPnlUsd: num(tr.realizedPnlUsd),
    unrealizedPnlUsd: num(tr.unrealizedPnlUsd),
    // Open positions read their live return; closed ones read what was banked.
    pnlPct: closed ? num(tr.percentageRealizedPnl) : num(tr.percentageUnrealizedPnl),
    likeCount: Number(it.comment?.numLikes ?? it.comment?.reactions?.counts?.likeCount) || 0,
    replyCount: Number(it.numReplies) || 0,
    createdAt: it.createdAt ? Date.parse(it.createdAt) || null : null,
    chain: NET_TO_CHAIN[Number(it.networkId)] ?? null,
  };
}

/**
 * One thesis per author — their most recent.
 *
 * A trader can post several theses on the same token over time; showing all of
 * them repeats the author and, because the list is ranked by position size
 * rather than date, often surfaces an older post instead of what they think
 * now. Collapsing to the latest per author (by createdAt) means each user
 * appears once, represented by their current take. A missing date sorts oldest
 * so a dated thesis always wins over an undated one for the same author.
 */
function latestPerAuthor(items: Thesis[]): Thesis[] {
  const best = new Map<string, Thesis>();
  const order: string[] = [];
  for (const t of items) {
    const key = (t.authorId || t.authorHandle || t.id).toLowerCase();
    const cur = best.get(key);
    if (!cur) { best.set(key, t); order.push(key); continue; }
    if ((t.createdAt ?? -1) > (cur.createdAt ?? -1)) best.set(key, t);
  }
  return order.map((k) => best.get(k)!);
}

/**
 * The backend's FOMO feed for a token, ranked like the FomoScan path.
 * Returns null (not an error) when the backend call fails, so theses() falls
 * through to FomoScan cleanly; on success the backend is authoritative, and an
 * empty result is an honest "no theses", not a fall-through.
 */
async function thesesViaFomo(ca: string, chainHint?: string): Promise<ThesisPage | { error: string } | null> {
  const chain = chainHint || "robinhood";
  const r = await thesisForToken(ca, chain, 0);
  // Backend down/walled → let FomoScan try rather than surfacing a raw error.
  if ("error" in r) return null;
  if (!r.v) return { items: [], count: 0, symbol: null, chain };
  const arr: any[] = Array.isArray(r.v) ? r.v : (r.v.items || r.v.theses || []);
  let items = arr.map(fromFomo);
  const symbol = arr[0]?.ticker ? String(arr[0].ticker) : null;
  const seen = new Set<string>();
  items = items.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  items = latestPerAuthor(items);                 // one per author — their latest
  items.sort((a, z) =>
    (z.positionUsd ?? 0) - (a.positionUsd ?? 0) ||
    (z.likeCount ?? 0) - (a.likeCount ?? 0) ||
    (z.createdAt ?? 0) - (a.createdAt ?? 0));
  return { items, count: items.length, symbol, chain: items[0]?.chain ?? chainHint ?? null };
}

/* ── theses ───────────────────────────────────────────────────────────────*/

/**
 * Theses for one token, ranked by the size of the position behind them.
 *
 * Ranking by holdings rather than recency is the point of the panel. Anyone can
 * type conviction; holding six figures through it is the part that costs
 * something, and sorting by it puts the expensive opinions first. Ties break on
 * endorsement then recency — likes matter as a tie-break because many records
 * carry no position figure at all, and ordering those by date alone throws away
 * the one signal they do have.
 */
export async function theses(ca: string, chainHint?: string): Promise<ThesisPage | { error: string }> {
  // Our backend is the primary source: the real feed, live, for every user.
  // FomoScan is only a fallback for when the backend is unreachable or walled.
  const direct = await thesesViaFomo(ca, chainHint).catch(() => null);
  // On success the backend is authoritative — its result is used even when
  // empty, so a token with no FOMO theses says so instead of falling to the
  // metered FomoScan key. Only a failed backend call (null) falls through below.
  if (direct) return direct;

  // The address is case-sensitive base58 on Solana, so it is passed through
  // exactly as given.
  const raw: any[] = [];
  let symbol: string | null = null;
  let before: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const path: string = `/v2/thesis/token/${encodeURIComponent(ca)}` +
      (before ? `?before=${encodeURIComponent(before)}` : "");
    const r = await fsGet<any>(path, { ttl: TTL, negTtl: 5 * 60_000 });
    // A failure on page one is a failure; on a later page we keep what we have
    // rather than throwing away three good pages over the fourth.
    if ("error" in r) {
      if (page === 0) return { error: r.error };
      break;
    }
    if (!r.v) break;                       // 404 — token not indexed
    symbol = symbol ?? (r.v.symbol ? String(r.v.symbol) : null);
    raw.push(...((r.v.items || []) as any[]));
    if (!r.v.hasMore || !r.v.nextBefore) break;
    before = String(r.v.nextBefore);
  }

  let items = raw.map(toThesis);

  // Guard against a cursor that loops: the same thesis twice would double a
  // position in the summary strip and misstate how much money is behind the
  // token.
  const seen = new Set<string>();
  items = items.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));

  // A token address can be shaped the same on two chains, so a Solana token's
  // commentary must not appear in a Robinhood panel.
  if (chainHint) items = items.filter((t) => !t.chain || t.chain === chainHint);

  items = latestPerAuthor(items);                 // one per author — their latest

  items.sort((a, z) =>
    (z.positionUsd ?? 0) - (a.positionUsd ?? 0) ||
    (z.likeCount ?? 0) - (a.likeCount ?? 0) ||
    (z.createdAt ?? 0) - (a.createdAt ?? 0));

  return { items, count: items.length, symbol, chain: items[0]?.chain ?? chainHint ?? null };
}
