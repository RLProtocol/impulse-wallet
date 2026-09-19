# Thesis feed & Pump.fun callouts — implementation guide

The trade panel has two "what are people saying about this token" tabs:

- **Thesis** — trader theses from FOMO, each shown next to the *size of the
  position* behind it. Served by our own backend.
- **Callouts** — public calls from pump.fun, each shown next to its *outcome*
  (the multiple it ran since the call). Read from pump.fun's private API.

Both are fetched by the background service worker (never the content script) and
rendered in the panel's Shadow DOM. This document covers where the data comes
from, its shape, and why each piece is built the way it is.

---

## 1. Thesis feed

### What a thesis is
A thesis is what a trader wrote about a position, and it arrives with the position
attached: how much they hold in USD and their running PnL. That pairing is the
whole point — an opinion next to the size of the bet behind it. The panel ranks by
**position size**, so the expensive opinions come first, not the most recent ones.

### The endpoint
The extension does **not** talk to FOMO directly (FOMO sits behind a Cloudflare
wall that a plain fetch can't clear). It calls our own always-on backend:

```
GET https://backend.getimpulse.online/thesis?ca=<address>&chain=<chain>&threshold=<usd>
Header: x-api-key: <shared key>
```

| param | required | default | notes |
|---|---|---|---|
| `ca` | yes | — | token contract (EVM `0x…` lowercased, or Solana base58 as-is) |
| `chain` | no | `robinhood` | `robinhood`, `base`, `eth`, `bnb`, `solana` |
| `threshold` | no | `0` | minimum position USD a thesis must clear |

Success is `{ "v": { "items": [ …FOMO thesis objects… ] } }`; failure is
`{ "error": "…" }` (including `503` when the backend session is temporarily
walled). Full endpoint contract lives in the backend's `API.md`.

### The data path
```
panel (x-inject) ──STRIX_FOMO {ca, chain}──▶ background.ts
      └─ fomo.theses(ca, chain)                         src/lib/fomo.ts
            ├─ thesisForToken(ca, chain, 0)             src/lib/fomoBackend.ts  ── GET /thesis
            │     ▲ primary source: our backend, live FOMO data for every user
            └─ FomoScan fallback (/v2/thesis/token/…)   src/lib/fomoscan.ts
                  ▲ only when the backend call FAILS (down/walled), not when it's empty
      ◀── ThesisPage { items, count, symbol, chain } ──┘
```

- **Primary:** [`thesesViaFomo()`](src/lib/fomo.ts) hits the backend via
  [`thesisForToken()`](src/lib/fomoBackend.ts). On success the backend is
  authoritative — an *empty* result is an honest "no theses", not a fall-through.
- **Fallback:** only a *failed* backend call (returns `null`) drops through to the
  metered FomoScan key, which walks up to `MAX_PAGES = 4` pages (100 theses).
- The backend base URL and API key are baked in (overridable via
  `VITE_FOMO_BACKEND_URL` / `VITE_FOMO_BACKEND_KEY`) and are **public by design** —
  the extension can be unpacked, so we rely on the backend's rate limiting, not on
  hiding the key.

### The normalized shape (`Thesis`)
FOMO's raw object is mapped to a stable internal shape in
[`fromFomo()`](src/lib/fomo.ts) (backend path) and [`toThesis()`](src/lib/fomo.ts)
(FomoScan path):

| field | meaning |
|---|---|
| `thesis` | the text (`comment.comment` on FOMO's object) |
| `authorHandle` / `authorName` / `authorId` | author *as they were when posted* — can be stale, never present as verified identity |
| `positionUsd` | **the ranking signal.** `usdValue` (money in the position); falls back to trade size; `null` when unknown (never faked to 0) |
| `positionKind` | `"held"` (open) or `"traded"` (closed) — so the row uses the right word |
| `holdingsUsd` / `tradeUsd` | current equity / trade size (often 0 even on big positions — that's the trap `positionUsd` avoids) |
| `realizedPnlUsd` / `unrealizedPnlUsd` / `pnlPct` | return; open positions read live (unrealized) %, closed read banked (realized) % |
| `likeCount` | endorsement — used as a rank tie-break |
| `createdAt` | ms epoch, or null |
| `chain` | mapped from `networkId` (4663→robinhood, 8453→base, 1→eth, 56→bnb, 1399811149→solana) |
| `avatar` | profile picture as a `data:` URI (inlined — see below), null until resolved |

### Ranking
`positionUsd` desc → `likeCount` desc → `createdAt` desc. Likes break ties because
many records carry no position figure at all, and ordering those by date alone
throws away the one signal they have.

### Avatars
The panel renders inside the host page, whose `img-src` CSP won't allow FOMO's S3
bucket. So [`withAvatars()`](src/lib/fomo.ts) fetches the bytes in the worker and
inlines them as `data:` URIs, **per visible page** (a token can carry 200 theses;
only ~5 are on screen). FOMO items carry their own picture URL; FomoScan items
don't, so those fall back to a one-call leaderboard avatar lookup keyed on handle,
and anyone outside the top 100 gets the seeded/generated disc.

### Message contract (content ↔ worker)
| message | payload | returns |
|---|---|---|
| `STRIX_FOMO` | `{ ca, chain? }` | `ThesisPage` (items already avatar-inlined) or `{ error }` |
| `STRIX_FOMO_AVATARS` | `{ handles: string[] }` (≤10) | `{ avatars: { [handle]: dataUri } }` for lazy paging |

### Caching
Backend `/thesis` is cached 60s server-side; the FomoScan fallback is cached 30
min on disk (the feed is additive — a new thesis changes the tail of a
position-ranked list, not its head).

---

## 2. Pump.fun callouts

### What a callout is
A callout is pump.fun's version of a thesis, and it carries something FOMO's does
**not**: the **outcome**. `calledAtMcap` is the market cap when the call was made
and `multiple` is where it went — so a caller is ranked on whether they were
*right*, not on how much they were holding. That's the one signal the thesis panel
can't compute for itself.

### The source
A **private, undocumented** pump.fun API, reverse-engineered from their own
bundles ([src/lib/callouts.ts](src/lib/callouts.ts)):

```
GET https://frontend-api-v3.pump.fun/callout/top/<mint>?limit=50
Header: accept: application/json
```

Notes that are load-bearing:
- **`/callout/top` is the one that returns data.** `/callout/list` exists but
  answers with an empty array.
- **No paging.** `offset`, `sort`, `filter`, `nextPageToken` are all accepted and
  ignored; `nextPageToken` always comes back empty. The endpoint caps at **50** no
  matter what `limit` you ask for. So the whole set is fetched once and paged in
  the panel.
- **Unversioned** — it can move on any pump.fun deploy. The panel degrades to an
  empty tab rather than an error when the shape changes.
- **Must be proxied through the background worker.** Its CORS header names
  pump.fun's own origin, so a content-script fetch is refused outright. `429`
  becomes a friendly "rate limited" message; any other non-2xx becomes `Pump.fun
  HTTP <status>`.

### The normalized shape (`Callout`)
Mapped in [`callouts()`](src/lib/callouts.ts) from pump.fun's raw row:

| field | from | meaning |
|---|---|---|
| `text` | `thesis` | the call itself (pump.fun names this "thesis" too) |
| `handle` | `username` | pump.fun handle |
| `xHandle` | `xUsername` | linked X account, or null |
| `verified` | `isVerified` | |
| `calledAtMcap` | `marketCap` | market cap when the call was made |
| `multiple` | `multiple` | **the ranking signal** — how far it ran |
| `createdAt` | `createdAt` | |
| `peakAt` | `peakTimestamp` | when it peaked, if it has |
| `avatar` / `avatarUrl` | `profileImage` | picture as `data:` URI / its source URL |

### Ranking
`multiple` desc → earliest `createdAt` first. Being right *first* is worth more
than being right after it already ran, so ties break on how early the call was.

### Avatar security (audit findings — do not loosen)
Callout avatars come from third-party JSON, so the URL and content-type are
attacker-influenced (a profile picture is user-set). [`inlineAvatar()`](src/lib/callouts.ts)
therefore:
1. **Host allowlist** — only `prod-fomo-profile-pics.s3.amazonaws.com`,
   `pump.mypinata.cloud`, `socialimages.pump.fun` over `https:` are fetched at all.
   (Unchecked, a crafted profile could point the worker at a LAN host — the request
   still fires even if the response can't be read.)
2. **Exact MIME match** — `^image/(png|jpeg|jpg|gif|webp|avif)$`, not a
   `startsWith("image/")` test. A header like `image/png" onerror="…` passes a
   prefix test and closes the `src` attribute early → script execution. The exact
   pattern blocks that.
3. **Size cap** — 300KB, else dropped.
4. Inlined as `data:<mime>;base64,…`.

Same page-at-a-time discipline as the thesis feed: 50 avatars is megabytes of
base64 for 5 visible rows.

### Message contract (content ↔ worker)
| message | payload | returns |
|---|---|---|
| `STRIX_CALLOUTS` | `{ ca }` (the mint) | `CalloutPage { items, count }` (first 5 avatar-inlined) or `{ error }` |
| `STRIX_CALLOUT_AVATARS` | `{ urls: string[] }` (≤10) | `{ avatars: { [url]: dataUri } }` for lazy paging |

### Caching
5 min per mint. An empty result is cached only briefly (so a token that just got
its first callout isn't stuck empty for the full window).

---

## Thesis vs. callout — at a glance

| | Thesis (FOMO) | Callout (pump.fun) |
|---|---|---|
| Signal | position size behind the opinion | outcome (multiple since the call) |
| Source | our backend → FOMO (FomoScan fallback) | pump.fun private API, direct |
| Ranked by | `positionUsd` → likes → recency | `multiple` → earliest call |
| Proxied via worker | yes (Cloudflare wall) | yes (CORS names pump.fun origin) |
| Paging | up to 100 (4 pages) | none; capped at 50 |
| Key files | `src/lib/fomo.ts`, `src/lib/fomoBackend.ts`, `src/lib/fomoscan.ts` | `src/lib/callouts.ts` |
| Worker messages | `STRIX_FOMO`, `STRIX_FOMO_AVATARS` | `STRIX_CALLOUTS`, `STRIX_CALLOUT_AVATARS` |

Both tabs are built to **degrade to empty, never to an error banner**, because
both sources are private and can move without notice.
