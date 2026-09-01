// FOMO client — trader "thesis" posts, keyed by token.
//
// A thesis is what a trader wrote about a position, and it arrives with the
// position attached: how much they hold in USD, and their running profit. That
// pairing is the whole reason it is worth showing — an opinion next to the size
// of the bet behind it.
//
// This talks to api.fomoapi.io, which needs NO API KEY. The previous provider
// did, and shipping a key inside an extension makes it a public key: anyone can
// unzip a published build and read it, and the shared allowance is then spent
// by strangers. That is what took this feature dark. An anonymous endpoint with
// a 600/minute per-IP limit removes the problem rather than working around it.

const HOST = "https://api.fomoapi.io";

/** Chain ids as this API reports them, mapped to our own keys. */
const NETWORK_TO_CHAIN: Record<string, string> = {
  "4663": "robinhood",
  "1399811149": "solana",
  "8453": "base",
  "1": "eth",
  "56": "bnb",
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
  /**
   * Profile picture as a data: URI, or null.
   *
   * NOT the remote URL. The panel renders inside the host page's document, so
   * an <img src> pointing at Amazon is loaded under THAT page's img-src policy
   * — and x.com's blocks it, which is why avatars silently never appeared.
   * The extension can fetch the host (it is in host_permissions), so the bytes
   * are inlined here and the page is never asked to reach out at all.
   */
  avatar: string | null;
  /** Current holdings in USD. Frequently 0 — see positionUsd. */
  holdingsUsd: number | null;
  /** Size of the trade in USD. Populated on many records where equity is not. */
  tradeUsd: number | null;
  /**
   * The money behind the words, and the ranking signal.
   *
   * `equity` alone is not it. On a sampled token 67 of 85 theses carried
   * equity 0 while reporting six- and seven-figure trades and PnL — so a 0
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

const TTL = 5 * 60_000;
const cache = new Map<string, { t: number; v: ThesisPage }>();

const num = (x: any): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/**
 * Percentage return on a position.
 *
 * The API gives absolute PnL and current equity but no percentage. Equity is
 * what the position is worth NOW, so cost basis is equity minus the unrealised
 * gain — deriving the percentage from equity alone would divide by the wrong
 * number and understate every winner.
 */
function pnlPercent(equity: number | null, tradeUsd: number | null, unrealized: number | null, realized: number | null): number | null {
  const gain = (unrealized ?? 0) + (realized ?? 0);
  if (!gain) return null;
  // Cost basis, best source first. Equity is what the position is worth NOW, so
  // the basis is equity minus the unrealised gain. Where equity is missing,
  // tradeUsd IS the basis — it is what they put in.
  let basis = equity && equity > 0 ? equity - (unrealized ?? 0) : 0;
  if (basis <= 0 && tradeUsd && tradeUsd > 0) basis = tradeUsd;
  if (basis <= 0) return null;
  return (gain / basis) * 100;
}

function toThesis(raw: any, i: number): Thesis {
  const equity = num(raw.equity);
  const trade = num(raw.tradeUsd);
  const unreal = num(raw.unrealizedPnlUsd);
  const real = num(raw.realizedPnlUsd);
  const position = equity && equity > 0 ? equity : trade && trade > 0 ? trade : null;
  return {
    id: `${raw.userId || raw.handle || i}-${raw.ts || i}`,
    thesis: String(raw.text || ""),
    authorHandle: String(raw.handle || ""),
    authorName: String(raw.name || raw.handle || ""),
    authorId: String(raw.userId || raw.handle || ""),
    authorIsDev: Boolean(raw.isDev),
    avatar: null,
    holdingsUsd: equity,
    tradeUsd: trade,
    positionUsd: position,
    positionKind: position == null ? null : equity && equity > 0 ? "held" : "traded",
    realizedPnlUsd: real,
    unrealizedPnlUsd: unreal,
    pnlPct: pnlPercent(equity, trade, unreal, real),
    likeCount: Number(raw.likes) || 0,
    replyCount: Number(raw.replies) || 0,
    createdAt: raw.ts ? Date.parse(raw.ts) || null : null,
    chain: NETWORK_TO_CHAIN[String(raw.networkId)] ?? null,
  };
}

/* ── avatars ───────────────────────────────────────────────────────────────
   A thesis carries no picture, so it has to be looked up per author. Two
   sources, cheapest first: the leaderboard returns a hundred traders with
   avatars in ONE call, and the per-user endpoint fills the rest. Both are
   cached for the session because a handle's picture does not move. */

const avatarCache = new Map<string, string | null>();   // handle -> data: URI
let leaderboardLoaded = false;

/** Hosts allowed to serve an avatar. Anything else is not fetched at all. */
const AVATAR_HOSTS = new Set([
  "prod-fomo-profile-pics.s3.amazonaws.com",
  "pump.mypinata.cloud",
  "socialimages.pump.fun",
]);

/**
 * Fetch a remote avatar and inline it as a data: URI.
 *
 * Two things here are load-bearing, and both were audit findings.
 *
 * The URL arrives inside third-party JSON, so it is attacker-influenced: a
 * profile picture is user-set on both platforms. Fetching it unchecked let a
 * crafted profile point the extension's background worker at any address it
 * liked — including a LAN host, where the request still fires even though the
 * response cannot be read. So the scheme and host are checked against a fixed
 * list before anything is requested.
 *
 * The Content-Type is likewise chosen by whoever served the bytes, and it used
 * to be pasted straight into `data:${ct};base64,…`. A header of
 * `image/png" onerror="…` passes a startsWith("image/") test and closes the
 * src attribute early, turning a profile picture into script execution. The
 * type is now matched against an exact pattern rather than merely inspected.
 */
const MIME_OK = /^image\/(png|jpeg|jpg|gif|webp|avif)$/;

async function inlineAvatar(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  let u: URL;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" || !AVATAR_HOSTS.has(u.hostname)) return null;
  try {
    const r = await fetch(u.toString());
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!MIME_OK.test(ct)) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 300_000) return null;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `data:${ct};base64,${btoa(bin)}`;
  } catch { return null; }
}

/** handle -> remote avatar URL, from one leaderboard call. Not yet inlined:
 *  100 traders is far more than any one panel shows. */
const avatarUrls = new Map<string, string>();

async function loadLeaderboardAvatars(): Promise<void> {
  if (leaderboardLoaded) return;
  leaderboardLoaded = true; // set first: one attempt, even if it fails
  try {
    const r = await fetch(`${HOST}/v2/leaderboard/all?limit=100`);
    if (!r.ok) return;
    for (const t of (await r.json())?.traders || []) {
      const h = String(t.handle || "").toLowerCase();
      if (h && t.avatar) avatarUrls.set(h, String(t.avatar));
    }
  } catch { /* avatars are decoration; the panel works without them */ }
}

async function avatarFor(handle: string): Promise<string | null> {
  const h = handle.toLowerCase();
  if (!h) return null;
  if (avatarCache.has(h)) return avatarCache.get(h)!;

  let url = avatarUrls.get(h) || null;
  if (!url) {
    try {
      const r = await fetch(`${HOST}/v2/users/${encodeURIComponent(handle)}`);
      url = r.ok ? (await r.json())?.avatar || null : null;
    } catch { url = null; }
  }
  const data = await inlineAvatar(url);
  avatarCache.set(h, data);
  return data;
}

/**
 * Fill in avatars for the authors on one page.
 *
 * Deliberately per-page rather than for the whole list: a token can carry two
 * hundred theses and only five are on screen. Resolving all of them would spend
 * the rate limit on rows nobody will look at.
 */
export async function withAvatars(items: Thesis[]): Promise<void> {
  await loadLeaderboardAvatars();
  await Promise.all(
    items.map(async (t) => {
      if (t.avatar) return;
      t.avatar = await avatarFor(t.authorHandle);
    }),
  );
}

/* ── theses ───────────────────────────────────────────────────────────────*/

/**
 * Theses for one token, ranked by the size of the position behind them.
 *
 * Ranking by holdings rather than recency is the point of the panel. Anyone can
 * type conviction; holding six figures through it is the part that costs
 * something, and sorting by it puts the expensive opinions first. Ties break on
 * recency so a wall of dust-sized positions still reads newest-first.
 */
export async function theses(ca: string, chainHint?: string): Promise<ThesisPage | { error: string }> {
  const key = ca.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  try {
    const r = await fetch(`${HOST}/v2/thesis/token/${encodeURIComponent(ca)}?limit=200`);
    if (r.status === 429) return { error: "Rate limited — try again shortly." };
    if (!r.ok) return { error: `FOMO HTTP ${r.status}` };
    const b = await r.json();

    let items = ((b?.theses || []) as any[]).map(toThesis);

    // The API accepts a `network` parameter and ignores it, so the chain filter
    // has to happen here. Without this a Solana token that shares an address
    // shape with ours would mix its commentary into a Robinhood panel.
    if (chainHint) items = items.filter((t) => !t.chain || t.chain === chainHint);

    // Position first, then endorsement, then recency. Likes matter as a
    // tie-break because most records carry no position figure at all, and
    // ordering those by date alone throws away the one signal they do have —
    // on the sampled token the top thesis had 274 likes, 13x the next.
    items.sort((a, z) =>
      (z.positionUsd ?? 0) - (a.positionUsd ?? 0) ||
      (z.likeCount ?? 0) - (a.likeCount ?? 0) ||
      (z.createdAt ?? 0) - (a.createdAt ?? 0));

    const v: ThesisPage = {
      items,
      count: items.length,
      symbol: items[0] ? String(b?.theses?.[0]?.token?.symbol || "") || null : null,
      chain: items[0]?.chain ?? chainHint ?? null,
    };
    // An empty page can mean "not indexed yet" rather than "nothing here", so
    // hold a miss for only a minute — a second look often has the data.
    cache.set(key, { t: v.count ? Date.now() : Date.now() - TTL + 60_000, v });
    return v;
  } catch (e: any) {
    return { error: (e?.message || String(e)).slice(0, 140) };
  }
}
