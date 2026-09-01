// Pump.fun callouts — a public call on a token, with the price it was made at.
//
// A callout is pump.fun's version of a thesis, and it carries something FOMO's
// does not: the OUTCOME. `calloutPrice` is the price when the call was made and
// `multiple` is where it went, so a caller can be ranked on whether they were
// right rather than on how much they were holding. That is the one signal the
// thesis panel cannot compute for itself.
//
// Two things to know about this source. It is a private API — reverse
// engineered from pump.fun's own bundles, undocumented and unversioned, so it
// can move on any deploy; the panel is built to degrade to an empty tab rather
// than an error when it does. And its CORS header names pump.fun's own origin,
// so it can only be called from the extension's background worker, never from
// the content script.

const HOST = "https://frontend-api-v3.pump.fun";

/** The endpoint caps at 50 however large a limit you ask for. Verified by
 *  asking for 100, 200 and 500 and getting 50 back each time. */
const MAX = 50;

export type Callout = {
  id: string;
  /** The call itself. pump.fun names this field "thesis" too. */
  text: string;
  handle: string;
  /** Linked X account, when the caller has one. */
  xHandle: string | null;
  verified: boolean;
  /** Profile picture as a data: URI — see the note in fomo.ts on why. */
  avatar: string | null;
  /** Where that picture came from. Kept so paging can inline it on demand. */
  avatarUrl: string | null;
  /** Market cap at the moment the call was made. */
  calledAtMcap: number | null;
  /** Multiple since the call. This is the ranking signal. */
  multiple: number | null;
  createdAt: number | null;
  /** When it peaked, if it has. */
  peakAt: number | null;
};

export type CalloutPage = { items: Callout[]; count: number };

const TTL = 5 * 60_000;
const cache = new Map<string, { t: number; v: CalloutPage }>();

const num = (x: any): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/* ── avatars ────────────────────────────────────────────────────────────────
   Same constraint as the thesis feed: the panel renders inside the host page,
   whose img-src will not allow pump.fun's IPFS gateway. The extension fetches
   the bytes and inlines them instead. */

const avatarCache = new Map<string, string | null>();

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

/** Inline the pictures for one page of callouts. Page at a time, deliberately:
 *  fifty avatars is megabytes of base64 for five visible rows. */
export async function withAvatars(items: Callout[]): Promise<void> {
  await Promise.all(items.map(async (c) => {
    if (c.avatar || !c.avatarUrl) return;
    const key = c.avatarUrl;
    if (avatarCache.has(key)) { c.avatar = avatarCache.get(key)!; return; }
    const data = await inlineAvatar(key);
    avatarCache.set(key, data);
    c.avatar = data;
  }));
}

/**
 * Callouts for one token, ranked by how far the call ran.
 *
 * `/callout/top` is the endpoint that returns data — `/callout/list` exists but
 * answers with an empty array. Neither pages: offset, sort, filter and
 * nextPageToken are all accepted and ignored, and nextPageToken always comes
 * back empty. So the whole set is fetched once and paged in the panel.
 */
export async function callouts(mint: string): Promise<CalloutPage | { error: string }> {
  const key = mint.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  try {
    const r = await fetch(`${HOST}/callout/top/${encodeURIComponent(mint)}?limit=${MAX}`, {
      headers: { accept: "application/json" },
    });
    if (r.status === 429) return { error: "Rate limited — try again shortly." };
    if (!r.ok) return { error: `Pump.fun HTTP ${r.status}` };
    const b = await r.json();

    const items: Callout[] = ((b?.callouts || []) as any[]).map((c, i) => ({
      id: String(c.calloutId || i),
      text: String(c.thesis || ""),
      handle: String(c.username || ""),
      xHandle: c.xUsername ? String(c.xUsername) : null,
      verified: Boolean(c.isVerified),
      avatar: null,
      avatarUrl: c.profileImage ? String(c.profileImage) : null,
      calledAtMcap: num(c.marketCap),
      multiple: num(c.multiple),
      createdAt: num(c.createdAt),
      peakAt: num(c.peakTimestamp),
    })) ;

    // Ranked on the outcome, which is the only thing a callout carries that a
    // thesis does not. Ties break on how early the call was — being right first
    // is worth more than being right after it already ran.
    items.sort((a, z) =>
      (z.multiple ?? 0) - (a.multiple ?? 0) ||
      (a.createdAt ?? 0) - (z.createdAt ?? 0));

    const v: CalloutPage = { items, count: items.length };
    cache.set(key, { t: v.count ? Date.now() : Date.now() - TTL + 60_000, v });
    return v;
  } catch (e: any) {
    return { error: (e?.message || String(e)).slice(0, 140) };
  }
}
