import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { CHAINS, DEFAULT_CHAIN, getActiveChain, isEvm, setActiveChain as persistChain, type ChainKey } from "./lib/chains";
import type { Address } from "viem";
import { formatEther } from "viem";
import * as ks from "./lib/keystore";
import * as sol from "./lib/solana";
import type { Account } from "./lib/keystore";
import { nativeBalance } from "./lib/wallet";
import { api } from "./lib/dex";
import { touchActivity, isIdleExpired, getSecurityAck } from "./lib/settings";

export type Screen =
  | { name: "home" }
  | { name: "send"; kind?: "native" | "token" | "stock"; address?: string }
  | { name: "receive" }
  | { name: "addToken" }
  | { name: "trade"; ca?: string }
  | { name: "stocks" }
  | { name: "asset"; kind: "native" | "token" | "stock"; address?: string }
  | { name: "chart"; kind: "native" | "token" | "stock"; address?: string; symbol?: string }
  | { name: "holders"; ca: string; symbol?: string }
  | { name: "accounts" }
  | { name: "leaderboard" }
  | { name: "popularity" }
  | { name: "copytrade"; handle?: string }
  | { name: "settings" };

type Toast = { id: number; kind: "ok" | "err" | "info"; msg: string };

type Ctx = {
  ready: boolean;
  hasWallet: boolean;
  unlocked: boolean;
  needsSecurity: boolean;
  address?: Address;
  accounts: Account[];
  activeId?: string;
  ethBalance: bigint;
  ethUsd: number | null;
  chain: ChainKey;
  setChain: (c: ChainKey) => Promise<void>;
  /** Base58 address for the active account, or null when it cannot have one
   *  (imported private-key accounts have no Solana counterpart). */
  solAddress: string | null;
  /** Lamports on Solana; 0 elsewhere. */
  solBalance: bigint;
  /** The address to show and copy for the selected chain. */
  activeAddress: string | undefined;
  screen: Screen;
  toasts: Toast[];
  go: (s: Screen) => void;
  back: () => void;
  refresh: () => Promise<void>;
  toast: (kind: Toast["kind"], msg: string) => void;
  reload: () => Promise<void>;
  lock: () => Promise<void>;
  switchAccount: (id: string) => Promise<void>;
  ackSecurity: () => void;
};

const WalletCtx = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside provider");
  return c;
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [hasWallet, setHasWallet] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [needsSecurity, setNeedsSecurity] = useState(false);
  const [address, setAddress] = useState<Address>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [ethBalance, setEthBalance] = useState<bigint>(0n);
  const [ethUsd, setEthUsd] = useState<number | null>(null);
  const [chain, setChainState] = useState<ChainKey>(DEFAULT_CHAIN);
  const [solAddress, setSolAddress] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<bigint>(0n);
  const [stack, setStack] = useState<Screen[]>([{ name: "home" }]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((kind: Toast["kind"], msg: string) => {
    const id = Date.now() + Math.floor(performance.now());
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const refresh = useCallback(async () => {
    const a = await ks.activeAccount();
    if (!a) return;
    setAddress(a.address);
    setActiveId(a.id);
    setAccounts(await ks.listAccounts());
    // Derived, not stored — see keystore.getUnlockedSol.
    try { setSolAddress(await ks.activeSolAddress()); } catch { setSolAddress(null); }
    if (isEvm(chain)) {
      try {
        setEthBalance(await nativeBalance(a.address, chain));
      } catch { /* rpc hiccup */ }
    } else {
      // Read it here so anything showing a native balance has one for the
      // chain in view — otherwise the previous chain's ETH lingers on screen.
      try {
        const sa = await ks.activeSolAddress();
        setSolBalance(sa ? await sol.solBalance(sa) : 0n);
      } catch { setSolBalance(0n); }
    }
    try {
      const { usd } = await api.nativePrice();
      setEthUsd(usd);
    } catch { /* offline */ }
  }, [chain]);

  // Restore the last picked chain once, before the first balance read.
  useEffect(() => { getActiveChain().then(setChainState); }, []);

  const setChain = useCallback(async (c: ChainKey) => {
    // Zero the cached balances first. refresh() is async, and without this the
    // previous chain's ETH sits on screen as if it were the new chain's.
    setEthBalance(0n);
    setSolBalance(0n);
    setChainState(c);
    await persistChain(c);
  }, []);

  const doLock = useCallback(async () => {
    await ks.lock();
    setUnlocked(false);
    setStack([{ name: "home" }]);
  }, []);

  const reload = useCallback(async () => {
    const has = await ks.hasVault();
    setHasWallet(has);
    let un = await ks.isUnlocked();
    // Auto-lock: if idle beyond the window, lock on open.
    if (un && (await isIdleExpired())) {
      await ks.lock();
      un = false;
    }
    setUnlocked(un);
    if (un) {
      await touchActivity();
      setNeedsSecurity(!(await getSecurityAck()));
      await refresh();
      const params = new URLSearchParams(location.search);
      const ca = params.get("ca");
      if (ca && /^0x[0-9a-fA-F]{40}$/.test(ca)) setStack([{ name: "home" }, { name: "trade", ca }]);
      const copy = params.get("copy");
      if (copy && /^[A-Za-z0-9_]{1,15}$/.test(copy)) setStack([{ name: "home" }, { name: "copytrade", handle: copy }]);
    }
    setReady(true);
  }, [refresh]);

  useEffect(() => { reload(); }, [reload]);

  // Track activity + auto-lock check while unlocked.
  useEffect(() => {
    if (!unlocked) return;
    const bump = () => { touchActivity(); };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    const id = setInterval(async () => {
      if (await isIdleExpired()) doLock();
      else refresh();
    }, 15_000);
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
      clearInterval(id);
    };
  }, [unlocked, refresh, doLock]);

  const go = useCallback((s: Screen) => { touchActivity(); setStack((st) => [...st, s]); }, []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);

  const switchAccount = useCallback(async (id: string) => {
    await ks.switchAccount(id);
    await refresh();
    setStack([{ name: "home" }]);
    toast("ok", "Account switched");
  }, [refresh, toast]);

  const ackSecurity = useCallback(() => setNeedsSecurity(false), []);

  const value: Ctx = {
    ready, hasWallet, unlocked, needsSecurity, address, accounts, activeId,
    ethBalance, ethUsd, chain, setChain, solAddress, solBalance,
    activeAddress: CHAINS[chain].vm === "svm" ? solAddress ?? undefined : address,
    screen: stack[stack.length - 1], toasts,
    go, back, refresh, toast, reload, lock: doLock, switchAccount, ackSecurity,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export const ethToUsd = (wei: bigint, usd: number | null): number | null =>
  usd == null ? null : Number(formatEther(wei)) * usd;
