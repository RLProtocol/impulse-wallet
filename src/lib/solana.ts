// Solana support, built on primitives we already ship.
//
// No @solana/web3.js: it is ~200KB and everything needed here is a few hundred
// lines against @noble (ed25519, sha256/512) and @scure/base (base58). The
// wire formats are stable and documented, and Jupiter hands back an already
// built transaction for swaps, so the only thing we serialise ourselves is a
// transfer.
import { hmac } from "@noble/hashes/hmac";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";

/**
 * Solana RPC endpoints, tried in order.
 *
 * api.mainnet-beta.solana.com is NOT here: it answers 403 "Access forbidden"
 * to any request carrying a browser Origin header, which is every request an
 * extension makes. It works from curl and from a server, so it looks healthy
 * in testing and then returns nothing at all in the product — which is exactly
 * how a funded wallet ends up showing a zero balance.
 */
export const SOL_RPCS: string[] = [
  import.meta.env.VITE_SOL_RPC,
  "https://solana-rpc.publicnode.com",
  "https://solana.leorpc.com/?api_key=FREE",
  // Last resort. Blocked for anything sending an Origin header, but a service
  // worker request may not, and a third option costs nothing when it is only
  // reached after the others have refused.
  "https://api.mainnet-beta.solana.com",
].filter(Boolean) as string[];

export const SOL_RPC = SOL_RPCS[0];
export const SOL_EXPLORER = "https://solscan.io";
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Wrapped SOL — Jupiter quotes are denominated in this for native routes. */
export const WSOL = "So11111111111111111111111111111111111111112";

export const b58 = {
  encode: (b: Uint8Array) => base58.encode(b),
  decode: (s: string) => base58.decode(s),
};

/** Cheap shape check — 32 bytes that base58-decode cleanly. */
export function isSolAddress(s: string): boolean {
  if (!s || /[0OIl]/.test(s) || s.length < 32 || s.length > 44) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/* ── keys ──────────────────────────────────────────────────────────────── */

const ED25519_CURVE = new TextEncoder().encode("ed25519 seed");
const HARDENED = 0x80000000;

/**
 * SLIP-0010 ed25519 derivation.
 *
 * Deliberately not @scure/bip32: that is secp256k1 (BIP32), and ed25519 uses a
 * different scheme where every level must be hardened and the child key is the
 * left half of the HMAC directly, with no point addition. Using BIP32 here
 * would produce a plausible-looking address that no wallet agrees with.
 */
function slip10(seed: Uint8Array, path: number[]): { key: Uint8Array; chainCode: Uint8Array } {
  let I = hmac(sha512, ED25519_CURVE, seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);
  for (const idx of path) {
    const i = idx | HARDENED; // ed25519 has no public derivation
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, i >>> 0, false);
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }
  return { key, chainCode };
}

export type SolKeypair = { secret: Uint8Array; publicKey: Uint8Array; address: string };

function keypairFromSeed32(seed32: Uint8Array): SolKeypair {
  const publicKey = ed25519.getPublicKey(seed32);
  return { secret: seed32, publicKey, address: base58.encode(publicKey) };
}

/** The account Phantom and Solflare show first for a phrase: m/44'/501'/0'/0'. */
export function fromMnemonic(mnemonic: string, account = 0): SolKeypair {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const { key } = slip10(seed, [44, 501, account, 0]);
  return keypairFromSeed32(key);
}

/** Import path for a raw key: 64-byte secret (Phantom export) or 32-byte seed. */
export function fromSecretKey(secret: Uint8Array | string): SolKeypair {
  const bytes = typeof secret === "string" ? base58.decode(secret) : secret;
  if (bytes.length === 64) return keypairFromSeed32(bytes.slice(0, 32));
  if (bytes.length === 32) return keypairFromSeed32(bytes);
  throw new Error("Solana secret key must be 32 or 64 bytes.");
}

export const signMessage = (msg: Uint8Array, secret: Uint8Array): Uint8Array =>
  ed25519.sign(msg, secret);

/**
 * The key in the form other Solana wallets import.
 *
 * Phantom, Solflare and the CLI all expect the 64-byte "secret key" — the
 * 32-byte seed followed by the 32-byte public key — encoded base58. Exporting
 * the bare seed produces something that looks right and every wallet rejects.
 */
export function exportSecretKey(kp: SolKeypair): string {
  const full = new Uint8Array(64);
  full.set(kp.secret, 0);
  full.set(kp.publicKey, 32);
  return base58.encode(full);
}

/* ── program-derived addresses ─────────────────────────────────────────── */

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** True when the point is NOT on the ed25519 curve, which is what makes an
 *  address a valid PDA (no private key can exist for it). */
function offCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return false;
  } catch {
    return true;
  }
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const prog = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, new Uint8Array([bump]), prog, PDA_MARKER];
    let len = 0;
    for (const p of parts) len += p.length;
    const buf = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    const hash = sha256(buf);
    if (offCurve(hash)) return { address: base58.encode(hash), bump };
  }
  throw new Error("No PDA bump found");
}

/** Associated token account for (owner, mint). */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return findProgramAddress(
    [base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)],
    ATA_PROGRAM,
  ).address;
}

/* ── RPC ───────────────────────────────────────────────────────────────── */

let rpcId = 0;
// Sticky: once an endpoint answers, keep using it rather than paying the
// failure of a dead one on every single call.
let preferred = 0;

export async function solRpc<T = any>(method: string, params: any[] = []): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  let lastErr: unknown = new Error("No Solana RPC configured.");
  for (let i = 0; i < SOL_RPCS.length; i++) {
    const idx = (preferred + i) % SOL_RPCS.length;
    try {
      const r = await fetch(SOL_RPCS[idx], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const j = await r.json();
      if (j.error) {
        // Tell "this endpoint won't serve me" apart from "the chain says no".
        // The free endpoints disagree about which methods they support and
        // signal it inconsistently: publicnode blocks getTokenAccountsByOwner
        // with HTTP 403 and code -32602, while leorpc intermittently answers
        // getBalance with -32603 and HTTP 200. Both are worth another
        // endpoint; a genuine "account not found" is not.
        const code = Number(j.error.code);
        const msg = String(j.error.message || "");
        const refused =
          r.status === 403 || r.status === 429 || r.status >= 500 ||
          code === -32052 || code === -32603 || code === -32005 ||
          /blocked|forbidden|rate.?limit|unauthorized|paid plan|not allowed/i.test(msg);
        if (!refused) throw new Error(msg || "Solana RPC error");
        lastErr = new Error(msg || "RPC refused");
        continue;
      }
      preferred = idx;
      return j.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function solBalance(address: string): Promise<bigint> {
  const r = await solRpc<{ value: number }>("getBalance", [address]);
  return BigInt(r?.value ?? 0);
}

export type SplHolding = { mint: string; amountRaw: bigint; decimals: number; ata: string };

/** Every SPL balance the owner holds, including Token-2022 mints. */
export async function splHoldings(owner: string): Promise<SplHolding[]> {
  const out: SplHolding[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      const r = await solRpc<any>("getTokenAccountsByOwner", [
        owner, { programId }, { encoding: "jsonParsed" },
      ]);
      for (const acc of r?.value || []) {
        const info = acc?.account?.data?.parsed?.info;
        const amt = info?.tokenAmount;
        if (!info?.mint || !amt) continue;
        const raw = BigInt(amt.amount || "0");
        if (raw <= 0n) continue;
        out.push({ mint: info.mint, amountRaw: raw, decimals: Number(amt.decimals ?? 0), ata: acc.pubkey });
      }
    } catch { /* one program failing should not hide the other */ }
  }
  return out;
}

export async function tokenSupplyDecimals(mint: string): Promise<number> {
  const r = await solRpc<any>("getTokenSupply", [mint]);
  return Number(r?.value?.decimals ?? 0);
}

export const solTxUrl = (sig: string) => `${SOL_EXPLORER}/tx/${sig}`;
export const solAddrUrl = (a: string) => `${SOL_EXPLORER}/account/${a}`;

/* ── transactions ──────────────────────────────────────────────────────── */

/** Solana's compact-u16 ("shortvec") length prefix. */
function shortvec(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return new Uint8Array(out);
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const u64le = (v: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};

export type Ix = {
  programId: string;
  /** Order matters — it is part of the instruction's ABI. */
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
};

/**
 * Serialise a legacy transaction and sign it.
 *
 * Account ordering is not cosmetic: the runtime derives the signer count and
 * the read-only boundaries from position alone, so keys must be sorted
 * signer-writable, signer-readonly, writable, readonly — with the fee payer
 * first — or the transaction is rejected as malformed.
 */
export function buildAndSignTx(
  ixs: Ix[],
  feePayer: string,
  recentBlockhash: string,
  secret: Uint8Array,
): string {
  const meta = new Map<string, { signer: boolean; writable: boolean }>();
  const note = (pk: string, signer: boolean, writable: boolean) => {
    const cur = meta.get(pk) || { signer: false, writable: false };
    meta.set(pk, { signer: cur.signer || signer, writable: cur.writable || writable });
  };
  note(feePayer, true, true);
  for (const ix of ixs) {
    for (const k of ix.keys) note(k.pubkey, k.isSigner, k.isWritable);
    note(ix.programId, false, false);
  }

  const rank = (pk: string) => {
    const m = meta.get(pk)!;
    return m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3;
  };
  const keys = [...meta.keys()].sort((a, b) => {
    if (a === feePayer) return -1;
    if (b === feePayer) return 1;
    return rank(a) - rank(b) || (a < b ? -1 : 1);
  });
  const idx = new Map(keys.map((k, i) => [k, i]));

  let numSigners = 0, roSigned = 0, roUnsigned = 0;
  for (const k of keys) {
    const m = meta.get(k)!;
    if (m.signer) { numSigners++; if (!m.writable) roSigned++; }
    else if (!m.writable) roUnsigned++;
  }

  const message = cat(
    new Uint8Array([numSigners, roSigned, roUnsigned]),
    shortvec(keys.length),
    ...keys.map((k) => base58.decode(k)),
    base58.decode(recentBlockhash),
    shortvec(ixs.length),
    ...ixs.map((ix) =>
      cat(
        new Uint8Array([idx.get(ix.programId)!]),
        shortvec(ix.keys.length),
        new Uint8Array(ix.keys.map((k) => idx.get(k.pubkey)!)),
        shortvec(ix.data.length),
        ix.data,
      ),
    ),
  );

  const sig = ed25519.sign(message, secret);
  const tx = cat(shortvec(1), sig, message);
  // btoa needs a binary string; the tx is small enough to build one directly.
  let bin = "";
  for (const b of tx) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* ── instructions ──────────────────────────────────────────────────────── */

export const transferSolIx = (from: string, to: string, lamports: bigint): Ix => ({
  programId: SYSTEM_PROGRAM,
  keys: [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: to, isSigner: false, isWritable: true },
  ],
  // System program instruction 2 = Transfer, index is a u32 little-endian.
  data: cat(new Uint8Array([2, 0, 0, 0]), u64le(lamports)),
});

/** TransferChecked (12) rather than Transfer (3): it verifies the mint and
 *  decimals on-chain, which turns a wrong-decimals bug into a failed tx
 *  instead of a transfer of the wrong size. */
export const transferSplIx = (
  sourceAta: string, mint: string, destAta: string, owner: string,
  amount: bigint, decimals: number, tokenProgram = TOKEN_PROGRAM,
): Ix => ({
  programId: tokenProgram,
  keys: [
    { pubkey: sourceAta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destAta, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ],
  data: cat(new Uint8Array([12]), u64le(amount), new Uint8Array([decimals])),
});

/** Idempotent create (1) — safe to include when the ATA may already exist. */
export const createAtaIx = (
  payer: string, ata: string, owner: string, mint: string, tokenProgram = TOKEN_PROGRAM,
): Ix => ({
  programId: ATA_PROGRAM,
  keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ],
  data: new Uint8Array([1]),
});

export async function latestBlockhash(): Promise<string> {
  const r = await solRpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  return r?.value?.blockhash;
}

export async function sendRawTx(base64Tx: string): Promise<string> {
  return solRpc<string>("sendTransaction", [
    base64Tx, { encoding: "base64", skipPreflight: false, maxRetries: 3 },
  ]);
}

export async function confirmTx(sig: string, timeoutMs = 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await solRpc<any>("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
      const st = r?.value?.[0];
      if (st?.err) throw new Error("Transaction failed on-chain.");
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true;
    } catch (e: any) {
      if (String(e?.message || "").includes("failed on-chain")) throw e;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/* ── trading ───────────────────────────────────────────────────────────── */
//
// PumpPortal first, Jupiter on any failure — the same order robinhoodcode's
// sibling in main.py uses. PumpPortal covers pump.fun bonding curves that
// Jupiter has no route for; Jupiter covers everything already graduated to a
// real AMM. Trying one and giving up loses half the market either way.

const PUMPPORTAL = "https://pumpportal.fun/api/trade-local";
const JUPITER = "https://lite-api.jup.ag/swap/v1";

export const SOL_DEFAULT_SLIPPAGE_PCT = 10;
export const SOL_DEFAULT_PRIORITY_FEE = 0.005; // SOL

/**
 * Replace the signatures on a transaction we were handed already built.
 *
 * Both providers return a fully-formed VersionedTransaction carrying a
 * placeholder signature. The layout is shortvec(count) + count*64 bytes +
 * message, so the message starts right after the placeholders — and for a v0
 * transaction the leading 0x80 version byte is part of the message and must
 * stay inside what we sign.
 */
/** Pull the message out of a serialised transaction, discarding the provider's
 *  placeholder signatures. Layout is shortvec(count) + count*64 + message. */
function extractMessage(raw: Uint8Array): Uint8Array {
  let off = 0, count = 0, shift = 0;
  for (;;) {
    const b = raw[off++];
    count |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 21) throw new Error("Malformed transaction from provider.");
  }
  const message = raw.slice(off + count * 64);
  if (!message.length) throw new Error("Provider returned an empty transaction.");
  return message;
}

/** Sign a message we have already checked. Never call this on provider bytes
 *  without running assertTradeTxSafe on them first. */
function signMessageBytes(message: Uint8Array, secret: Uint8Array): string {
  const sig = ed25519.sign(message, secret);
  const tx = cat(shortvec(1), sig, message);
  let bin = "";
  for (const b of tx) bin += String.fromCharCode(b);
  return btoa(bin);
}

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export type SolTradeResult = { signature: string; via: "pumpportal" | "jupiter" };

async function pumpPortalTrade(
  kp: SolKeypair, mint: string, action: "buy" | "sell",
  amount: string, denominatedInSol: "true" | "false",
  slippagePct: number, priorityFee: number, maxSpendLamports: bigint,
): Promise<string> {
  const r = await fetch(PUMPPORTAL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      publicKey: kp.address,
      action,
      mint,
      amount,
      denominatedInSol,
      slippage: String(slippagePct),
      priorityFee: String(priorityFee),
      pool: "auto",
    }),
  });
  if (!r.ok) throw new Error(`PumpPortal ${r.status}`);
  const raw = new Uint8Array(await r.arrayBuffer());
  const message = extractMessage(raw);
  await assertTradeTxSafe(message, kp, maxSpendLamports);
  return sendRawTx(signMessageBytes(message, kp.secret));
}

async function jupiterTrade(
  kp: SolKeypair, mint: string, action: "buy" | "sell",
  rawAmount: bigint, slippagePct: number, priorityFee: number, maxSpendLamports: bigint,
): Promise<string> {
  const inputMint = action === "buy" ? WSOL : mint;
  const outputMint = action === "buy" ? mint : WSOL;
  const q = new URLSearchParams({
    inputMint, outputMint,
    amount: rawAmount.toString(),
    slippageBps: String(Math.round(slippagePct * 100)),
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false",
  });
  const qr = await fetch(`${JUPITER}/quote?${q}`);
  if (!qr.ok) throw new Error("Jupiter route unavailable.");
  const quoteResponse = await qr.json();

  const sr = await fetch(`${JUPITER}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userPublicKey: kp.address,
      quoteResponse,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFee > 0 ? Math.round(priorityFee * 1e9) : "auto",
    }),
  });
  if (!sr.ok) throw new Error("Jupiter couldn't build the transaction.");
  const { swapTransaction } = await sr.json();
  if (!swapTransaction) throw new Error("Jupiter returned no transaction.");
  const message = extractMessage(b64ToBytes(swapTransaction));
  await assertTradeTxSafe(message, kp, maxSpendLamports);
  return sendRawTx(signMessageBytes(message, kp.secret));
}

/** Raw balance + decimals for one mint, used to size a percentage sell. */
export async function splBalance(owner: string, mint: string): Promise<{ raw: bigint; decimals: number }> {
  const r = await solRpc<any>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  let raw = 0n, decimals = 0;
  for (const acc of r?.value || []) {
    const amt = acc?.account?.data?.parsed?.info?.tokenAmount;
    if (!amt) continue;
    raw += BigInt(amt.amount || "0");
    decimals = Number(amt.decimals ?? 0);
  }
  return { raw, decimals };
}

export async function solBuy(
  kp: SolKeypair, mint: string, amountSol: number,
  slippagePct = SOL_DEFAULT_SLIPPAGE_PCT, priorityFee = SOL_DEFAULT_PRIORITY_FEE,
): Promise<SolTradeResult> {
  try {
    const lamports = BigInt(Math.round(amountSol * 1e9));
    const sig = await pumpPortalTrade(kp, mint, "buy", String(amountSol), "true", slippagePct, priorityFee, lamports);
    return { signature: sig, via: "pumpportal" };
  } catch (e) {
    if (String((e as any)?.message || "").startsWith("Refused:")) throw e;
    const lamports = BigInt(Math.round(amountSol * 1e9));
    const sig = await jupiterTrade(kp, mint, "buy", lamports, slippagePct, priorityFee, lamports);
    return { signature: sig, via: "jupiter" };
  }
}

export async function solSell(
  kp: SolKeypair, mint: string, pct: number,
  slippagePct = SOL_DEFAULT_SLIPPAGE_PCT, priorityFee = SOL_DEFAULT_PRIORITY_FEE,
): Promise<SolTradeResult> {
  const clamped = Math.max(1, Math.min(100, Math.round(pct)));
  try {
    // A sell should never reduce our SOL beyond fees.
    const sig = await pumpPortalTrade(kp, mint, "sell", `${clamped}%`, "false", slippagePct, priorityFee, 0n);
    return { signature: sig, via: "pumpportal" };
  } catch (e) {
    if (String((e as any)?.message || "").startsWith("Refused:")) throw e;
    const { raw } = await splBalance(kp.address, mint);
    if (raw <= 0n) throw new Error("No token balance to sell.");
    const amount = (raw * BigInt(clamped)) / 100n;
    if (amount <= 0n) throw new Error("Sell amount rounds to zero - try a larger %.");
    const sig = await jupiterTrade(kp, mint, "sell", amount, slippagePct, priorityFee, 0n);
    return { signature: sig, via: "jupiter" };
  }
}

/**
 * Net SOL a sell actually credited.
 *
 * Both providers return as soon as the transaction is broadcast, so reading
 * the wallet balance straight after reports the pre-sell figure and a winning
 * trade records as -100%. Read the transaction's own pre/post balance for the
 * fee payer instead, which is exact and immune to balance-RPC lag.
 */
export async function solProceeds(signature: string, timeoutMs = 30_000): Promise<number> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await solRpc<any>("getTransaction", [
        signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ]);
      if (res) {
        if (res.meta?.err) return 0;
        const pre = res.meta?.preBalances || [], post = res.meta?.postBalances || [];
        if (pre.length && post.length) return Math.max(0, (post[0] - pre[0]) / 1e9);
      }
    } catch { /* not indexed yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0;
}

/**
 * Send SOL or an SPL token.
 *
 * For a token the recipient may have no account for that mint yet, so an
 * idempotent create is prepended — without it the transfer fails against an
 * address that looks perfectly valid, which is the single most confusing way
 * for a send to break.
 */
export async function solTransfer(
  kp: SolKeypair, to: string, amountRaw: bigint,
  mint?: string, decimals = 0,
): Promise<string> {
  if (!isSolAddress(to)) throw new Error("That is not a valid Solana address.");
  const ixs: Ix[] = [];
  if (!mint) {
    ixs.push(transferSolIx(kp.address, to, amountRaw));
  } else {
    const from = associatedTokenAddress(kp.address, mint);
    const dest = associatedTokenAddress(to, mint);
    const info = await solRpc<any>("getAccountInfo", [dest, { encoding: "base64" }]).catch(() => null);
    if (!info?.value) ixs.push(createAtaIx(kp.address, dest, to, mint));
    ixs.push(transferSplIx(from, mint, dest, kp.address, amountRaw, decimals));
  }
  const bh = await latestBlockhash();
  return sendRawTx(buildAndSignTx(ixs, kp.address, bh, kp.secret));
}

/* ── verifying a transaction we did not build ──────────────────────────── */

/**
 * Read the fee payer and signer count out of a serialised message.
 *
 * Layout: an optional version byte (v0 sets the high bit), then a three-byte
 * header, then a shortvec count and that many 32-byte account keys. The first
 * key is always the fee payer.
 */
function readMessageHead(message: Uint8Array): { signers: number; feePayer: string } {
  let o = 0;
  if (message[0] & 0x80) o += 1; // versioned transaction prefix
  const signers = message[o];
  o += 3; // numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
  let keys = 0, shift = 0;
  for (;;) {
    const b = message[o++];
    keys |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
    if (shift > 21) throw new Error("Malformed transaction from provider.");
  }
  if (!keys) throw new Error("Transaction from provider has no accounts.");
  return { signers, feePayer: base58.encode(message.slice(o, o + 32)) };
}

/**
 * Refuse to sign a provider transaction that does not look like our trade.
 *
 * PumpPortal and Jupiter hand back a finished transaction and we sign it. That
 * is a total-loss surface: if either were compromised, the bytes they return
 * could move every lamport we hold and we would sign them without ever knowing
 * what the instructions said. This is the same "blind signing" problem hardware
 * wallets exist to prevent.
 *
 * Two checks, cheap and worth having:
 *  - the transaction must need exactly our one signature, and we must be the
 *    fee payer. A tx wanting a second signer, or paying from someone else, is
 *    not the swap we asked for.
 *  - simulate it and read our own lamport delta. A buy should cost roughly what
 *    the user agreed to plus fees; anything materially larger is refused. A
 *    sell should not reduce our SOL at all beyond fees.
 *
 * Simulation is advisory: if the RPC cannot simulate we allow the trade rather
 * than block it, because the structural checks above still hold and refusing
 * every trade whenever an endpoint is flaky is its own failure.
 */
export async function assertTradeTxSafe(
  message: Uint8Array, kp: SolKeypair, maxSpendLamports: bigint,
): Promise<void> {
  const { signers, feePayer } = readMessageHead(message);
  if (signers !== 1) {
    throw new Error("Refused: this transaction asks for another signature besides yours.");
  }
  if (feePayer !== kp.address) {
    throw new Error("Refused: this transaction is not paid for by your wallet.");
  }

  // Structural checks passed. Now see what it actually does to our balance.
  try {
    const b64 = (() => {
      const sig = new Uint8Array(64); // placeholder; sigVerify is off
      const tx = cat(shortvec(1), sig, message);
      let s = "";
      for (const b of tx) s += String.fromCharCode(b);
      return btoa(s);
    })();
    const sim = await solRpc<any>("simulateTransaction", [
      b64,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        accounts: { encoding: "base64", addresses: [kp.address] },
      },
    ]);
    if (sim?.value?.err) return; // a failing sim is not evidence of theft
    const post = sim?.value?.accounts?.[0]?.lamports;
    if (typeof post !== "number") return;
    const pre = await solBalance(kp.address);
    const spent = pre - BigInt(post);
    // Allow the agreed amount plus generous headroom for fees, priority fees
    // and rent on a new token account.
    const ceiling = maxSpendLamports + 30_000_000n;
    if (spent > ceiling) {
      throw new Error(
        `Refused: this transaction would spend ${(Number(spent) / 1e9).toFixed(4)} SOL, ` +
        `far more than the ${(Number(maxSpendLamports) / 1e9).toFixed(4)} SOL you approved.`,
      );
    }
  } catch (e: any) {
    if (String(e?.message || "").startsWith("Refused:")) throw e;
    // Simulation unavailable - the structural checks already ran.
  }
}
