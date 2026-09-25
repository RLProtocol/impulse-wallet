// Impulse Thesis client — the community's own theses, served by our backend.
//
// Distinct from the FOMO feed (fomoBackend.ts / fomo.ts): these are written by
// Impulse users about tokens they hold, with a username and optional display
// picture, gated to holders. Same backend host and key as fomoBackend.

// Ordered hosts to try: Railway primary, custom domains as fallback. A THROW
// (network/permission) rolls to the next host; any HTTP response is final. This
// mirrors fomoBackend.ts so both clients survive a browser that only granted one
// of the backend host permissions.
const ENV_BASE = String(import.meta.env.VITE_FOMO_BACKEND_URL || "");
const BASES = [...new Set([
  ...(ENV_BASE ? [ENV_BASE] : []),
  "https://backend.getimpulse.site",
  "https://impulse-fomo-production.up.railway.app",
].map((b) => b.replace(/\/+$/, "")))];
const KEY = String(import.meta.env.VITE_FOMO_BACKEND_KEY || "a9ac56c0a3a317d15fb9ed819e91eae4fda25fbe3b15471498928fceb57ebe96");

export type ImpulseAuthor = { wallet: string; username: string; dp: string | null };
export type ImpulseThesis = {
  id: string;
  text: string;
  chain: string;
  holdingAmount: number;
  holdingUsd: number | null;
  createdAt: number;
  likes: number;
  mine: boolean;
  author: ImpulseAuthor;
};
export type ImpulseProfile = { wallet: string; username: string; dp: string | null; createdAt: number } | null;

type R<T> = { v: T } | { error: string };

async function req<T = any>(method: "GET" | "POST", path: string, body?: any): Promise<R<T>> {
  let lastErr = "backend unreachable";
  for (const base of BASES) {
    let r: Response;
    try {
      r = await fetch(base + path, {
        method,
        headers: {
          "x-api-key": KEY,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e: any) {
      lastErr = (e?.message || String(e)).slice(0, 140);
      continue;                              // this host unreachable — try the next
    }
    let j: any;
    try { j = await r.json(); } catch { return { error: `backend HTTP ${r.status}` }; }
    if (!r.ok) return { error: String(j?.error || `backend HTTP ${r.status}`).slice(0, 200) };
    return "v" in j ? { v: j.v as T } : { error: "backend returned no data" };
  }
  return { error: lastErr };
}

const enc = encodeURIComponent;

/** Theses for a token, ranked by holding, joined with author profiles. `wallet`
 *  is the viewer, so the backend can flag their own rows. */
export function listTheses(ca: string, chain: string | undefined, wallet: string) {
  return req<{ items: ImpulseThesis[]; count: number }>(
    "GET",
    `/impulse/thesis?ca=${enc(ca)}${chain ? `&chain=${enc(chain)}` : ""}&wallet=${enc(wallet)}`,
  );
}

/** The profile for a wallet, or null. */
export function getProfile(wallet: string) {
  return req<ImpulseProfile>("GET", `/impulse/profile?wallet=${enc(wallet)}`);
}

/** Create or update a profile. `dp` is a data:image URI or null. */
export function setProfile(wallet: string, username: string, dp: string | null) {
  return req<ImpulseProfile>("POST", "/impulse/profile", { wallet, username, dp });
}

/** Popularity counters for a token, aggregated across all users. */
export function stats(ca: string) {
  return req<{ seen: number; opened: number }>("GET", `/impulse/stats?ca=${enc(ca)}`);
}

/** Bump a token's seen/opened counter. Fire-and-forget from the caller. */
export function track(ca: string, kind: "seen" | "open") {
  return req<{ seen: number; opened: number }>("POST", "/impulse/track", { ca, kind });
}

export type TrendingToken = {
  ca: string; seen: number; opened: number;
  symbol: string | null; name: string | null; image: string | null;
  mcap: number | null; chain: string | null;
};
export type Trending = {
  totalTokens: number; totalSeen: number; totalOpened: number;
  topSeen: TrendingToken[]; topOpened: TrendingToken[];
};

/** Popularity summary: totals + top-3 seen and top-3 opened, enriched with
 *  symbol/image/mcap. Powers the extension's Popularity tab. */
export function trending() {
  return req<Trending>("GET", "/impulse/trending");
}

export type LeaderRow = {
  wallet: string; username: string; dp: string | null;
  pnl: number; realized: number; unrealized: number;
  invested: number; volume: number; trades: number; tokens: number;
};

/** Log a completed trade (author = the caller's wallet, attached in background). */
export function logTrade(p: {
  wallet: string; ca: string; chain: string; symbol: string;
  side: "buy" | "sell"; tokenAmount: number; priceUsd: number; usdValue: number;
}) {
  return req<{ ok: boolean }>("POST", "/impulse/trade", p);
}

/** Top wallets by profit over a window: "24h" | "7d" | "30d" | "all". */
export function leaderboard(window: string) {
  return req<{ window: string; entries: LeaderRow[]; updatedAt: number }>(
    "GET", `/impulse/leaderboard?window=${enc(window)}`);
}

/** Write a thesis. The holder-gate is enforced by the caller (background). */
export function writeThesis(p: {
  wallet: string;
  tokenAddress: string;
  chain: string;
  text: string;
  holdingAmount: number;
  holdingUsd: number | null;
}) {
  return req<ImpulseThesis>("POST", "/impulse/thesis", p);
}
