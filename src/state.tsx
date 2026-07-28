import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Address } from "viem";
import { formatEther } from "viem";
import * as ks from "./lib/keystore";
import type { Account } from "./lib/keystore";
import { nativeBalance } from "./lib/wallet";
import { api } from "./lib/dex";
import { touchActivity, isIdleExpired, getSecurityAck } from "./lib/settings";

export type Screen =
  | { name: "home" }
  | { name: "send" }
  | { name: "receive" }
  | { name: "addToken" }
  | { name: "trade"; ca?: string }
  | { name: "stocks" }
  | { name: "asset"; kind: "native" | "token" | "stock"; address?: string }
  | { name: "chart"; kind: "native" | "token" | "stock"; address?: string; symbol?: string }
  | { name: "holders"; ca: string; symbol?: string }
  | { name: "accounts" }
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
    try {
      setEthBalance(await nativeBalance(a.address));
    } catch { /* rpc hiccup */ }
    try {
      const { usd } = await api.nativePrice();
      setEthUsd(usd);
    } catch { /* offline */ }
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
      const ca = new URLSearchParams(location.search).get("ca");
      if (ca && /^0x[0-9a-fA-F]{40}$/.test(ca)) setStack([{ name: "home" }, { name: "trade", ca }]);
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
    ethBalance, ethUsd, screen: stack[stack.length - 1], toasts,
    go, back, refresh, toast, reload, lock: doLock, switchAccount, ackSecurity,
  };
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export const ethToUsd = (wei: bigint, usd: number | null): number | null =>
  usd == null ? null : Number(formatEther(wei)) * usd;
