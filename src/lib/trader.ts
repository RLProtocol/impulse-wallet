// Resolve an X handle to a trader, across FOMO and pump.fun.
//
// Both are looked up by the X handle itself, which is how people actually name
// themselves across these platforms. The catch is that name equality is not
// proof: @unipcs on X and "unipcs" on FOMO could be different people, and
// showing one person's positions on another's profile would be a serious thing
// to get wrong.
//
// So the match is graded rather than assumed. When the trading account itself
// names the X handle — pump.fun's `x_username`, FOMO's `profile.twitterHandle`
// — that is a link the account asserted about itself, and it is reported as
// confirmed. When only the handles happen to be spelled the same, the data is
// still shown, labelled as a name match so the reader can weigh it. What is
// never done is presenting the second case as though it were the first.

const FOMO = "https://api.fomoapi.io";
const PUMP = "https://frontend-api-v3.pump.fun";

export type Trade = {
  id: string;
  symbol: string;
  address: string | null;
  /** "open" or "closed". Decides which PnL figure is the live one. */
  status: string;
  amount: number | null;
  /** Realised for a closed trade, unrealised for an open one. */
  pnlUsd: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  createdAt: number | null;
  closedAt: number | null;
};

/** A live event from the alert stream: a buy, sell or thesis as it happens. */
export type LiveEvent = {
  type: string;
  token: string | null;
  address: string | null;
  text: string;
  usdValue: number | null;
  ts: number | null;
};

export type Holding = {
  symbol: string;
  address: string | null;
  valueUsd: number | null;
  amount: number | null;
  change24h: number | null;
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
  holdings: Holding[];
  /** Summed from holdings — the API's own total reads 0 even with 196 rows. */
  portfolioUsd: number | null;
  /** Most recent trades. The endpoint returns newest first. */
  trades: Trade[];
  /**
   * When that trade history was captured.
   *
   * It is a SNAPSHOT, not a live read — measured at 3.6 days old on two
   * traders who had both traded within the hour. The panel prints this so a
   * stale list is never mistaken for a current one.
   */
  tradesAsOf: number | null;
  /** Activity since the snapshot, from the live alert stream. */
  live: LiveEvent[];
  /** Lifetime counts, which dwarf the 20 rows above: 113 open / 2182 closed on
   *  one sampled trader. Shown so the recent list is not mistaken for all of it. */
  activeCount: number | null;
  closedCount: number | null;
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

const jget = async (url: string): Promise<any | null> => {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
};

async function fomoHoldings(handle: string): Promise<Holding[]> {
  const b = await jget(`${FOMO}/v2/users/${encodeURIComponent(handle)}/balances`);
  return ((b?.holdings || []) as any[])
    .map((h) => ({
      symbol: String(h.token?.symbol || "?"),
      address: h.token?.address ? String(h.token.address) : null,
      valueUsd: num(h.valueUsd),
      amount: num(h.amount),
      change24h: num(h.change24h),
    }))
    .filter((h) => (h.valueUsd ?? 0) > 0)
    .sort((a, z) => (z.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

/** Newest trades for a handle. 20 is what the panel shows. */
async function fomoTrades(handle: string): Promise<{ trades: Trade[]; active: number | null; closed: number | null; asOf: number | null }> {
  const b = await jget(`${FOMO}/v2/users/${encodeURIComponent(handle)}/trades?limit=20`);
  const trades = ((b?.trades || []) as any[]).map((t, i) => {
    const closed = String(t.status || "") === "closed";
    return {
      id: String(t.tradeId || i),
      symbol: String(t.token?.symbol || "?"),
      address: t.token?.address ? String(t.token.address) : null,
      status: String(t.status || "open"),
      amount: num(t.amount),
      // Only one of the two is meaningful at a time, so the row shows that one
      // rather than making the reader work out which applies.
      pnlUsd: closed ? num(t.realizedPnlUsd) : num(t.unrealizedPnlUsd),
      entryPrice: num(t.avgEntryPrice),
      exitPrice: num(t.avgExitPrice),
      createdAt: t.createdAt ? Date.parse(t.createdAt) || null : null,
      closedAt: t.closedAt ? Date.parse(t.closedAt) || null : null,
    };
  });
  return {
    trades,
    active: num(b?.activeCount),
    closed: num(b?.closedCount),
    asOf: b?.capturedAt ? Date.parse(b.capturedAt) || null : null,
  };
}

/**
 * Recent activity for one trader, from the live alert stream.
 *
 * This exists because /trades is a days-old snapshot. The REST firehose cannot
 * help — it ignores a trader filter and only reaches back about half an hour
 * across 150+ traders — but the socket accepts ?trader= and replays its buffer
 * on connect. So: open, take the buffered replay, close. No socket is held.
 */
function liveActivity(handle: string, ms = 2500): Promise<LiveEvent[]> {
  return new Promise((resolve) => {
    const out: LiveEvent[] = [];
    let ws: WebSocket;
    try {
      ws = new WebSocket(`wss://api.fomoapi.io/ws/alerts?trader=${encodeURIComponent(handle)}`);
    } catch { resolve(out); return; }

    const done = () => {
      try { ws.close(); } catch { /* already closing */ }
      resolve(out.sort((a, z) => (z.ts ?? 0) - (a.ts ?? 0)).slice(0, 15));
    };
    const timer = setTimeout(done, ms);

    ws.onmessage = (m: MessageEvent) => {
      try {
        const d = JSON.parse(String(m.data));
        if (d?.type === "welcome" || !d) return;
        // The stream carries follows and price alerts too; only actions belong
        // in a trade list.
        const kind = String(d.alertType || d.type || "");
        if (!["buy", "sell", "transfer", "thesis"].includes(kind)) return;
        out.push({
          type: kind,
          token: d.token ? String(d.token) : null,
          address: d.tokenAddress ? String(d.tokenAddress) : null,
          text: String(d.text || ""),
          usdValue: num(d.usdValue),
          ts: num(d.ts),
        });
      } catch { /* malformed frame */ }
    };
    ws.onerror = () => { clearTimeout(timer); done(); };
    ws.onclose = () => { clearTimeout(timer); resolve(out.slice(0, 15)); };
  });
}

async function fomoSide(x: string): Promise<FomoSide | null> {
  const f = await jget(`${FOMO}/v2/users/${encodeURIComponent(x)}`);
  if (!f || !f.handle) return null;

  // A directory record is a shell: nulls throughout, wallets still resolving.
  // Showing it would put an empty profile behind a confident-looking button.
  const empty = f.pnlUsd == null && f.trades == null && f.followers == null;
  if (empty && f.source === "directory") return null;

  const tw = f.profile?.twitterHandle || f.profile?.twitter;
  const link: Link =
    tw && (eq(tw, x) || eq(String(tw).split("/").pop(), x)) ? "confirmed" : "name";

  const [holdings, tr, live] = await Promise.all([
    fomoHoldings(String(f.handle)),
    fomoTrades(String(f.handle)),
    liveActivity(String(f.handle)).catch(() => [] as LiveEvent[]),
  ]);
  const sum = holdings.reduce((n, h) => n + (h.valueUsd ?? 0), 0);

  return {
    handle: String(f.handle),
    displayName: f.displayName ? String(f.displayName) : null,
    bio: f.profile?.bio ? String(f.profile.bio) : null,
    avatar: await inlineAvatar(f.avatar || null),
    followers: num(f.followers),
    verified: Boolean(f.verified),
    link,
    wallets: { solana: f.wallets?.solana || null, evm: f.wallets?.evm || null },
    pnl: f.pnl
      ? { "24h": num(f.pnl["24h"]), "7d": num(f.pnl["7d"]), "30d": num(f.pnl["30d"]), all: num(f.pnl.all) }
      : null,
    tradeCount: num(f.trades),
    volumeUsd: num(f.volumeUsd),
    avgHoldSeconds: num(f.profile?.averageHoldTimeSeconds),
    accountAgeDays: num(f.profile?.accountAgeDays),
    holdings,
    portfolioUsd: sum > 0 ? sum : null,
    trades: tr.trades,
    tradesAsOf: tr.asOf,
    live,
    activeCount: tr.active,
    closedCount: tr.closed,
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
export async function traderForX(xHandle: string): Promise<Trader | null> {
  const key = xHandle.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  const [fomo, pump] = await Promise.all([
    fomoSide(xHandle).catch(() => null),
    pumpSide(xHandle).catch(() => null),
  ]);
  const out: Trader | null = fomo || pump ? { xHandle, fomo, pump } : null;
  cache.set(key, { t: Date.now(), v: out });
  return out;
}
