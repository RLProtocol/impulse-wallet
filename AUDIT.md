# Impulse Wallet — internal security review

**Version reviewed:** 2.4.0 · **Date:** 31 August 2026 · **Reviewer:** internal, pre-engagement

This is the self-review carried out before handing the code to an external
auditor. It records what was examined, what was found, what was fixed, and —
more usefully for whoever reviews next — what was *not* verified.

---

## 1. Scope

The browser extension only. Everything in `src/`, the generated manifest in
`vite.config.ts`, and the packaging scripts.

Explicitly **out of scope and not shipped**: `server/`, a separate Python
service that holds its own keys in `server/.env`. It is not part of the
extension, shares no code with it, and is excluded from the audit bundle by
construction (see §6).

Two prior reviews covered versions up to 2.3.0 and found seven issues, all
fixed. This review targets the code added since: multi-chain routing
(`rhroute.ts`), the Pons launchpad (`pons.ts`), the social panels (`fomo.ts`,
`callouts.ts`, `trader.ts`), and the two new content-script docks.

## 2. Threat model

The extension holds private keys and can spend funds. It renders data from
seven third-party APIs inside pages it does not control. So the questions that
matter are:

1. Can key material leave the device?
2. Can a **web page** cause a trade, read the panel, or reach the background?
3. Can a **third-party API** — compromised, or simply serving user-controlled
   fields — execute script, or steer the extension's network access?
4. Can a user lose funds to a bad pool, a honeypot, or a mispriced trade?

## 3. Findings

Three issues, all introduced after 2.3.0, all fixed in this version.

### A1 · Remote `Content-Type` injected into markup — HIGH

Avatar and token-logo bytes were inlined as data URIs so the host page never
has to fetch them. The MIME type was taken from the response header and
interpolated directly:

```js
const ct = r.headers.get("content-type") || "image/jpeg";
if (!ct.startsWith("image/")) return null;      // insufficient
return `data:${ct};base64,${btoa(bin)}`;
```

The header is chosen by whoever serves the bytes. `image/png" onerror="…`
passes `startsWith("image/")` and closes the `src` attribute early:

```html
<img src="data:image/png" onerror="alert(1);base64,AAAA" alt="" />
<!--                      ^ now an event handler, not part of the URI -->
```

Reachable from three paths — `fomo.ts`, `callouts.ts`, `trader.ts` — plus the
`STRIX_IMAGE` proxy used for token logos. Delivery requires only that a user
open the panel; no interaction beyond that.

**Fixed.** The type is now matched against an exact pattern
(`/^image\/(png|jpeg|jpg|gif|webp|avif)$/`) after stripping parameters, rather
than merely inspected. Nothing that fails it is rendered.

### A2 · Server-side request forgery via avatar URLs — MEDIUM

Avatar URLs arrive inside third-party JSON and were fetched unchecked by the
background service worker:

```js
async function inline(url) { const r = await fetch(url); … }
```

A profile picture is user-set on both FOMO and pump.fun, so the field is
attacker-influenced without either service being compromised. The worker would
issue a request to any address — including `http://localhost:8545` or a LAN
host. Cross-origin reads are blocked without host permission, but the request
still fires, which is enough for blind SSRF and internal port discovery.

**Fixed.** URLs are parsed and checked before any request: HTTPS only, and the
hostname must be one of three known avatar hosts. `STRIX_IMAGE` gained the same
check against an eight-host image allowlist.

### A3 · Missing `data:` guard on the profile avatar — LOW

`traderHtml` emitted `<img src="${av}">` with no check on `av`. It was safe
only because the value happened to be produced by our own inliner — a property
of the current call graph, not of the code. Defence in depth against A1.

**Fixed.** Both avatar renderers now require the value to begin with
`data:image/` and fall back to the app logo otherwise.

### Verification

Each fix was tested against the exploit that motivated it, plus variants:

| Input | Result |
|---|---|
| `image/png" onerror="alert(1)` | rejected — logo fallback |
| `image/png;charset=x" onerror="…` | accepted as `image/png`, payload stripped |
| `image/svg+xml` | rejected |
| `http://192.168.1.1/a.png` | rejected — scheme |
| `http://localhost:8545/` | rejected — scheme |
| `https://evil.example.com/a.png` | rejected — host |
| `https://pump.mypinata.cloud.evil.com/x.png` | rejected — host |
| `file:///etc/passwd` | rejected — scheme |

8/8 emit no dangerous markup and issue no request.

## 4. Areas examined, no findings

**Key material.** `keystore.ts` and `storage.ts` contain no `fetch` and no URL.
None of the code added since 2.3.0 imports or references key material —
verified by search across `fomo.ts`, `callouts.ts`, `trader.ts`, `rhroute.ts`,
`pons.ts`. Keys are PBKDF2-SHA256 at 310,000 iterations into AES-GCM-256, with
a fresh 16-byte salt and 12-byte IV per write.

**Page → extension boundary.** The panel renders in a **closed** shadow root,
so the host page cannot reach into it. Every control requires
`event.isTrusted`, so synthetic clicks cannot drive a trade. The background
rejects any message whose `sender.id` is not our own extension id. All 21
message handlers were enumerated; the five added this cycle validate and clamp
their inputs (`STRIX_TRADER` requires `/^[A-Za-z0-9_]{1,15}$/`; the avatar
handlers slice to 10 entries).

**Trade-path text injection.** Thesis and callout text is escaped before URLs
are linkified, so no markup survives to be linked. Tested against 12 hostile
inputs — script tags, `<img onerror>`, `javascript:` URLs, attribute-breaking
quotes, entity smuggling, angle brackets inside URLs: every emitted tag was our
own anchor with an `http(s)` href.

**Lock enforcement.** `STRIX_BUY` and `STRIX_SELL` both call `requireUnlocked()`,
which fails closed on idle expiry — enforced in the background, not only in the
interface.

**Dependencies.** `npm audit --omit=dev`: 0 vulnerabilities.

**Secrets in source.** No API key, private key or bot token appears anywhere in
the shipped tree. Enforced mechanically by the bundler in §6.

## 5. Trade-safety controls

Separate from the security findings, these are the controls that stand between
a user and a bad fill. Worth an auditor's attention because they are the ones
that lose money when wrong.

- **Exit proof.** Every buy quotes the sale of what it would receive, through
  the same pool. Under 70% round-trip, or an unpriceable exit, refuses. This
  guard previously **allowed** the trade when the sell-back quote reverted —
  the loudest honeypot signal read as permission. It now fails closed.
- **Depth floor.** Pools under $500, or trades over 10% of pool depth, refused.
- **Fair-price guard.** A fill 60% worse than the token's true market price —
  taken from the deepest pair anywhere, including unroutable ones — refused.
- **Snipe tax.** Pons buys inside the five-second window where tax reaches 99%
  are refused with an explanation.
- **Unpriceable sells** are refused rather than sent with `amountOutMin = 0`.

## 6. The audit bundle

`scripts/audit-bundle.py` builds the archive sent to reviewers. Two properties
matter:

**Allowlisted, not denylisted.** Only named paths can enter. A denylist ships
whatever it forgets, and this repository sits beside `server/`, which holds
`OWNER_PRIVATE_KEY` and `BUYER_KEY`. Excluding by omission would be one
oversight away from leaking them; excluding by construction is not.

**It refuses to build on a secret-shaped string.** Every file is scanned for
API keys, PEM blocks, bot tokens and bare 32-byte hex. The build fails rather
than writing an archive that carries one. During this review it correctly
stopped on a 32-byte hex literal in `docs/`; that turned out to be a
transaction hash, so the rule now clears a match only when the preceding text
names it (`tx`, `hash`, `poolId`, …) — narrowing the exception rather than
dropping the rule.

## 7. What has NOT been verified

Stated plainly, because it is the most useful part of this document.

**No transaction has ever been broadcast from this code.** Quotes, routing
decisions, pool-key resolution and every guard above are verified against live
chain state. Gas estimation, nonce sequencing, Permit2 approvals landing before
their swap, and the three-transaction ERC-20 bonding-curve flow have never met
a real block. The routing rewrite is the largest change in this release and it
is untested in execution.

**No formal review of the cryptography.** SLIP-0010 derivation is checked
against all four official test vectors and the resulting addresses match
Phantom and Solflare for the same phrase. That is a correctness check, not a
cryptographic review.

**Two third-party APIs are private and undocumented.** pump.fun's callouts and
user endpoints were reverse-engineered from their own bundles. They can change
shape without notice. Both are behind feature flags so a breakage hides a tab
rather than breaking the panel — but their responses are trusted input, and
that is exactly the trust boundary A1 and A2 were found on.

**Third-party availability is a single point of failure** for the research
panels, not for trading. Trading depends only on chain RPCs.

## 8. Suggested focus for the external review

1. The trade execution path end to end, with real transactions — the untested
   area above.
2. `rhroute.ts` and `pons.ts` routing: whether a crafted token or pool can
   steer a swap into a venue the guards do not cover.
3. The remaining third-party trust boundaries, now that two were found here.
4. `x-inject.tsx` — the largest file, and the only one that runs inside pages
   the user does not control.
