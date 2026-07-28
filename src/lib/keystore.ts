// Multi-account encrypted keystore. One password protects the whole wallet.
// Accounts are either HD (derived from a single recovery phrase, MetaMask-style)
// or imported (their own private key / phrase). Secrets are encrypted at rest
// with AES-GCM + PBKDF2-SHA256 (310k). Nothing plaintext is persisted; while
// unlocked, the derived keys live only in chrome.storage.session (memory).

import { english, generateMnemonic, privateKeyToAccount } from "viem/accounts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { bytesToHex, type Hex } from "viem";
import { getItem, setItem, removeItem, getSession, setSession, clearSession } from "./storage";

const VAULT_KEY = "strix.vault.v1"; // same storage slot; holds v1 or v2 shape
const SESSION_KEY = "strix.session.v2";
const PBKDF2_ITERS = 310_000;

type EncBlob = { cipher: string; iv: string; salt: string };
type SecretPayload = { pk: Hex; mnemonic?: string };

export type Account = {
  id: string;
  label: string;
  address: `0x${string}`;
  kind: "hd" | "imported";
  hdIndex?: number; // hd only
  secret?: EncBlob; // imported only (encrypted {pk, mnemonic?})
  hasMnemonic: boolean;
};

export type Vault = {
  version: 2;
  seed: EncBlob | null; // encrypted primary recovery phrase (HD seed)
  accounts: Account[];
  activeId: string;
  hdNext: number;
};

type V1Vault = { version: 1; address: `0x${string}`; hasMnemonic: boolean } & EncBlob & { createdAt: number };
type Session = { mnemonic: string | null; pks: Record<string, Hex> };

const enc = new TextEncoder();
const dec = new TextDecoder();
const uuid = () => (crypto as any).randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);

function b64(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password) as unknown as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
async function encrypt(password: string, obj: unknown): Promise<EncBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, enc.encode(JSON.stringify(obj)) as unknown as BufferSource);
  return { cipher: b64(ct), iv: b64(iv), salt: b64(salt) };
}
async function decrypt<T>(password: string, blob: EncBlob): Promise<T> {
  const key = await deriveKey(password, unb64(blob.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) as unknown as BufferSource }, key, unb64(blob.cipher) as unknown as BufferSource);
  return JSON.parse(dec.decode(pt)) as T;
}

function deriveFromMnemonic(mnemonic: string, index: number): { pk: Hex; address: `0x${string}` } {
  const seed = mnemonicToSeedSync(mnemonic.trim().toLowerCase());
  const child = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);
  if (!child.privateKey) throw new Error("Failed to derive key");
  const pk = bytesToHex(child.privateKey) as Hex;
  return { pk, address: privateKeyToAccount(pk).address };
}

export function newMnemonic(): string {
  return generateMnemonic(english);
}
export function mnemonicIsValid(m: string): boolean {
  return validateMnemonic(m.trim().toLowerCase(), wordlist);
}
export function normalizePk(input: string): Hex {
  let s = input.trim();
  if (!s.startsWith("0x")) s = "0x" + s;
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error("Invalid private key (need 64 hex chars).");
  return s as Hex;
}

async function readRaw(): Promise<Vault | V1Vault | undefined> {
  return getItem<Vault | V1Vault>(VAULT_KEY);
}
export async function getVault(): Promise<Vault | undefined> {
  const v = await readRaw();
  return v && (v as any).version === 2 ? (v as Vault) : undefined;
}
export async function hasVault(): Promise<boolean> {
  return !!(await readRaw());
}

async function setSessionFor(vault: Vault, mnemonic: string | null, extraPks: Record<string, Hex>): Promise<void> {
  const pks: Record<string, Hex> = { ...extraPks };
  if (mnemonic) for (const a of vault.accounts) if (a.kind === "hd") pks[a.id] = deriveFromMnemonic(mnemonic, a.hdIndex!).pk;
  await setSession(SESSION_KEY, { mnemonic, pks } as Session);
}

// ── create / import (first wallet) ──────────────────────────────────────────
export async function createWallet(password: string): Promise<{ mnemonic: string }> {
  const mnemonic = newMnemonic();
  const { address } = deriveFromMnemonic(mnemonic, 0);
  const vault: Vault = {
    version: 2, seed: await encrypt(password, mnemonic),
    accounts: [{ id: uuid(), label: "Account 1", address, kind: "hd", hdIndex: 0, hasMnemonic: true }],
    activeId: "", hdNext: 1,
  };
  vault.activeId = vault.accounts[0].id;
  await setItem(VAULT_KEY, vault);
  await setSessionFor(vault, mnemonic, {});
  return { mnemonic };
}

export async function importFromMnemonic(mnemonic: string, password: string): Promise<void> {
  if (!mnemonicIsValid(mnemonic)) throw new Error("Invalid recovery phrase.");
  const m = mnemonic.trim().toLowerCase();
  const { address } = deriveFromMnemonic(m, 0);
  const vault: Vault = {
    version: 2, seed: await encrypt(password, m),
    accounts: [{ id: uuid(), label: "Account 1", address, kind: "hd", hdIndex: 0, hasMnemonic: true }],
    activeId: "", hdNext: 1,
  };
  vault.activeId = vault.accounts[0].id;
  await setItem(VAULT_KEY, vault);
  await setSessionFor(vault, m, {});
}

export async function importFromPrivateKey(pkInput: string, password: string): Promise<void> {
  const pk = normalizePk(pkInput);
  const address = privateKeyToAccount(pk).address;
  const id = uuid();
  const vault: Vault = {
    version: 2, seed: null,
    accounts: [{ id, label: "Account 1", address, kind: "imported", secret: await encrypt(password, { pk }), hasMnemonic: false }],
    activeId: id, hdNext: 0,
  };
  await setItem(VAULT_KEY, vault);
  await setSessionFor(vault, null, { [id]: pk });
}

// ── unlock (with lazy v1 -> v2 migration) ───────────────────────────────────
export async function unlock(password: string): Promise<Vault> {
  const raw = await readRaw();
  if (!raw) throw new Error("No wallet found.");

  if ((raw as any).version === 1) {
    const v1 = raw as V1Vault;
    const secret = await decrypt<SecretPayload>(password, v1).catch(() => { throw new Error("Wrong password."); });
    const id = uuid();
    let vault: Vault;
    if (secret.mnemonic) {
      vault = { version: 2, seed: await encrypt(password, secret.mnemonic),
        accounts: [{ id, label: "Account 1", address: v1.address, kind: "hd", hdIndex: 0, hasMnemonic: true }],
        activeId: id, hdNext: 1 };
      await setItem(VAULT_KEY, vault);
      await setSessionFor(vault, secret.mnemonic, {});
    } else {
      vault = { version: 2, seed: null,
        accounts: [{ id, label: "Account 1", address: v1.address, kind: "imported", secret: await encrypt(password, { pk: secret.pk }), hasMnemonic: false }],
        activeId: id, hdNext: 0 };
      await setItem(VAULT_KEY, vault);
      await setSessionFor(vault, null, { [id]: secret.pk });
    }
    return vault;
  }

  const vault = raw as Vault;
  let mnemonic: string | null = null;
  if (vault.seed) mnemonic = await decrypt<string>(password, vault.seed).catch(() => { throw new Error("Wrong password."); });
  const imported: Record<string, Hex> = {};
  for (const a of vault.accounts) {
    if (a.kind === "imported" && a.secret) {
      const s = await decrypt<SecretPayload>(password, a.secret).catch(() => { throw new Error("Wrong password."); });
      imported[a.id] = s.pk;
    }
  }
  // If there is no seed and no imported secret decrypted yet, verify password by decrypting the first available secret (done above).
  await setSessionFor(vault, mnemonic, imported);
  return vault;
}

async function getSessionData(): Promise<Session | undefined> {
  return getSession<Session>(SESSION_KEY);
}
export async function isUnlocked(): Promise<boolean> {
  return !!(await getSessionData());
}
export async function getUnlockedPk(): Promise<Hex | undefined> {
  const s = await getSessionData();
  const v = await getVault();
  if (!s || !v) return undefined;
  return s.pks[v.activeId];
}
export async function lock(): Promise<void> {
  await clearSession(SESSION_KEY);
}

// ── accounts ────────────────────────────────────────────────────────────────
export async function listAccounts(): Promise<Account[]> {
  return (await getVault())?.accounts || [];
}
export async function activeAccount(): Promise<Account | undefined> {
  const v = await getVault();
  return v?.accounts.find((a) => a.id === v.activeId);
}
export async function switchAccount(id: string): Promise<void> {
  const v = await getVault();
  if (!v || !v.accounts.some((a) => a.id === id)) return;
  v.activeId = id;
  await setItem(VAULT_KEY, v);
}
export async function renameAccount(id: string, label: string): Promise<void> {
  const v = await getVault();
  if (!v) return;
  const a = v.accounts.find((x) => x.id === id);
  if (a) { a.label = label.trim() || a.label; await setItem(VAULT_KEY, v); }
}

// Add a new HD account (no password needed — uses the in-session recovery phrase).
export async function addHdAccount(label?: string): Promise<Account> {
  const v = await getVault();
  const s = await getSessionData();
  if (!v) throw new Error("No wallet.");
  if (!s?.mnemonic) throw new Error("This wallet has no recovery phrase. Import a key instead.");
  const idx = v.hdNext;
  const { pk, address } = deriveFromMnemonic(s.mnemonic, idx);
  const acc: Account = { id: uuid(), label: label?.trim() || `Account ${v.accounts.length + 1}`, address, kind: "hd", hdIndex: idx, hasMnemonic: true };
  v.accounts.push(acc);
  v.hdNext = idx + 1;
  v.activeId = acc.id;
  await setItem(VAULT_KEY, v);
  s.pks[acc.id] = pk;
  await setSession(SESSION_KEY, s);
  return acc;
}

// Add an imported account (needs the wallet password to encrypt with the same key).
export async function addImportedAccount(secretInput: string, password: string, kind: "pk" | "seed", label?: string): Promise<Account> {
  const v = await getVault();
  const s = await getSessionData();
  if (!v || !s) throw new Error("Unlock the wallet first.");
  // Verify the password matches the wallet.
  const probe = v.seed || v.accounts.find((a) => a.secret)?.secret;
  if (probe) await decrypt(password, probe).catch(() => { throw new Error("Wrong password."); });

  let pk: Hex; let mnemonic: string | undefined;
  if (kind === "seed") {
    if (!mnemonicIsValid(secretInput)) throw new Error("Invalid recovery phrase.");
    mnemonic = secretInput.trim().toLowerCase();
    pk = deriveFromMnemonic(mnemonic, 0).pk;
  } else {
    pk = normalizePk(secretInput);
  }
  const address = privateKeyToAccount(pk).address;
  if (v.accounts.some((a) => a.address.toLowerCase() === address.toLowerCase())) throw new Error("That account is already in your wallet.");
  const acc: Account = { id: uuid(), label: label?.trim() || `Account ${v.accounts.length + 1}`, address, kind: "imported", secret: await encrypt(password, { pk, mnemonic }), hasMnemonic: !!mnemonic };
  v.accounts.push(acc);
  v.activeId = acc.id;
  await setItem(VAULT_KEY, v);
  s.pks[acc.id] = pk;
  await setSession(SESSION_KEY, s);
  return acc;
}

export async function removeAccount(id: string): Promise<void> {
  const v = await getVault();
  const s = await getSessionData();
  if (!v || v.accounts.length <= 1) throw new Error("You can't remove your only account.");
  v.accounts = v.accounts.filter((a) => a.id !== id);
  if (v.activeId === id) v.activeId = v.accounts[0].id;
  await setItem(VAULT_KEY, v);
  if (s) { delete s.pks[id]; await setSession(SESSION_KEY, s); }
}

// Reveal the ACTIVE account's secret (requires the password again).
export async function revealSecret(password: string): Promise<{ pk: string; mnemonic?: string; label: string }> {
  const v = await getVault();
  if (!v) throw new Error("No wallet found.");
  const a = v.accounts.find((x) => x.id === v.activeId)!;
  if (a.kind === "hd") {
    if (!v.seed) throw new Error("No recovery phrase for this account.");
    const mnemonic = await decrypt<string>(password, v.seed).catch(() => { throw new Error("Wrong password."); });
    return { pk: deriveFromMnemonic(mnemonic, a.hdIndex!).pk, mnemonic, label: a.label };
  }
  const s = await decrypt<SecretPayload>(password, a.secret!).catch(() => { throw new Error("Wrong password."); });
  return { pk: s.pk, mnemonic: s.mnemonic, label: a.label };
}

export async function wipeWallet(): Promise<void> {
  await clearSession(SESSION_KEY);
  await removeItem(VAULT_KEY);
}
