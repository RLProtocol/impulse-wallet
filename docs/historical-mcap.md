# Market cap at a point in time

How to answer "what was this token worth at 06:09:32 last Tuesday" on Robinhood
Chain, to the second, without an archive node.

Written up because the obvious approaches all fail quietly, and because the
caller-tracking feature depends on getting this right.

---

## The shape of the problem

```
market cap(t) = price(t) × supply(t)
```

Both halves are harder than they look.

**Supply** is easy *if* the token is fixed-supply. Pons launches mint 1B once
and never again, so `totalSupply()` today is also the supply last week. For a
token that mints or burns, this breaks — and you cannot read historical supply,
because that needs archive state (see below).

**Price** is the real work. Three sources, only two of which are any use:

| Source | Historical? | Verdict |
|---|---|---|
| DexScreener | no — current price plus 5m/1h/6h/24h deltas only | useless here |
| GeckoTerminal OHLCV | yes, `before_timestamp` | **default choice** |
| On-chain swap logs | yes, exact | **fallback, and proof** |

---

## Why not just read the pool at that block?

The intuitive approach — `eth_call` the pool's reserves at a historical block —
does not work. Robinhood Chain's public RPC keeps state for roughly **5,000
blocks**, and at a 0.101s block time that is about **eight minutes** of history.

```
eth_call at head-10       ✓
eth_call at head-200      ✓
eth_call at head-5000     ✓
eth_call at head-100000   ✗
```

`eth_getLogs` is the thing that saves this. Logs are indexed separately from
state and are retained far longer, so reading *events* works where reading
*state* does not. Everything below is built on that.

---

## Path A — GeckoTerminal candle (use this by default)

One HTTP call. Returns the last candle at or before the timestamp.

```
GET https://api.geckoterminal.com/api/v2/networks/robinhood/pools/{pool}
      /ohlcv/minute
      ?aggregate=1
      &before_timestamp={unix}
      &limit=1
      &currency=usd
      &token={contract}
```

Take `ohlcv_list[0][4]` — the close — and multiply by supply.

### `&token=` is not optional

Leave it out and the endpoint prices the pool in its default orientation, which
is usually the *other* side. This is silent and the number looks plausible:

```
without &token=   close 0.9994      →  "market cap" $4,152     ← the USDG side
with    &token=   close 337.82      →  market cap  $1,403,443
```

Both are numbers. Only one is the token you asked about.

### Granularity

`minute` has short retention, `hour` reaches much further back. Ask for minute
first and fall back to hour — a caller scorecard does not turn on a 40-minute
difference, but a launch-day snapshot might.

---

## Path B — the actual swap (exact, and provable)

When you need the real fill rather than a bucket, or the token is too new or
too thin for GeckoTerminal to have indexed it.

### 1. Timestamp → block

Do **not** binary search blindly; a naive search over a 2M-block range cost
7.6 seconds. Seed the guess from the block time and refine:

```ts
let guess = head.number - BigInt(Math.round((headTs - target) / 0.101));
// then step by (drift / blockTime) until within a second or two
```

Three to five calls, and it lands on the exact block.

### 2. Find the nearest swap

```ts
c.getLogs({ address: pool, fromBlock: blk - span, toBlock: blk + span })
```

**Always filter by `address`.** An unfiltered query over 500 blocks returned
13,550 logs and blew the response size limit. Filtered to one pool, 50,000
blocks returned 514.

Widen the span until a swap is caught: `600 → 6,000 → 60,000 → 400,000`.

### 3. Decode

**Uniswap V2** — `Swap(address,uint256,uint256,uint256,uint256,address)`
Data is four uint256: `amount0In, amount1In, amount0Out, amount1Out`.

```ts
const amt0 = format(a0In + a0Out, dec0);
const amt1 = format(a1In + a1Out, dec1);
const price = tokenIsToken0 ? amt1 / amt0 : amt0 / amt1;   // in quote units
```

**Uniswap V3** — `Swap(address,address,int256,int256,uint160,uint128,int24)`
Easier: `sqrtPriceX96` is in the log. Amounts are signed, so take absolutes.

### 4. Convert the quote to USD

The price is denominated in whatever the pool is quoted in:

- **USDG** → already dollars.
- **WETH** → multiply by ETH's USD price *at that same timestamp*.
- **anything else** → you now have a second historical price to resolve.
  Prefer a stable- or WETH-quoted pool when the token has more than one.

---

## Worked example, verified

`$IF (What If)` — `0x232CDFc415D10b673845D83Dc02ba2eaBe7e30d1`
at `2026-07-24T06:09:32Z`:

```
target ts 1784873372  →  block 17,922,348   (off by 0s)

nearest swap   block 17,921,500, 84s earlier
               tx 0xa2b7cf310516a0e698740c20a8c447fcf408f13dd768f6686cc99b537ca4dfc6
               4.337446e-6 WETH  →  $0.00815141   (ETH ≈ $1,879)
supply         1,000,000,000

MCAP           $8,151,405
```

Path A returned **$8,151,405** as well — two independent sources, identical to
the cent.

---

## Limits worth stating in the UI

**Precision is bounded by trade frequency, not by the method.** There was no
trade at 06:09:32; the nearest was 84 seconds earlier. Show the swap's real
timestamp rather than implying the figure is exact to the second. Anything
claiming a to-the-second price on an untraded second is interpolating.

**This is FDV, not circulating cap.** `totalSupply × price`. Identical for
fixed-supply Pons tokens; wrong for anything with locked or vesting supply.

**Supply is assumed constant.** True for Pons launches and the tokenised
stocks. If you ever support a mintable token, capture supply at record time —
you cannot reconstruct it afterwards.

---

## When building on this

For anything you can see happening live — a pill being injected, a trade being
placed — **record the price and supply at that moment** rather than
reconstructing them later. It is exact, free, and needs no RPC archaeology.

Reserve this document's techniques for **backfill**: reconstructing history you
did not capture, so a feature can launch with data instead of empty. That is a
job you run once.

See `src/lib/histmcap.ts` for the implementation.
