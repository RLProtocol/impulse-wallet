import { useEffect, useState } from "react";
import { useWallet } from "../state";
import { ScreenHeader, Copyable, Spinner, IconChevronDown } from "../components/ui";
import * as ks from "../lib/keystore";
import { CHAINS, addrUrlOn } from "../lib/chains";
import { getAutoLockMin, setAutoLockMin, AUTOLOCK_OPTIONS } from "../lib/settings";

const lockLabel = (m: number) => (m === 0 ? "Never" : m === 1 ? "1 minute" : `${m} minutes`);

/**
 * Turn the inline terminal on for whatever site the user is looking at.
 *
 * X is built in. Everything else is granted one origin at a time, on purpose:
 * a wallet that asks to read every page you visit is a worse install prompt
 * and a much harder store review than one that asks only when you say so.
 */
function SiteToggle() {
  const [origin, setOrigin] = useState<string>();
  const [host, setHost] = useState<string>();
  const [state, setState] = useState<"loading" | "on" | "off" | "builtin" | "unsupported">("loading");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url || "";
      if (!/^https?:\/\//.test(url)) { setState("unsupported"); return; }
      const u = new URL(url);
      setOrigin(u.origin);
      setHost(u.host);
      const r = await chrome.runtime.sendMessage({ type: "STRIX_SITE_STATUS", origin: u.origin });
      setState(r?.builtin ? "builtin" : r?.enabled ? "on" : "off");
    } catch {
      setState("unsupported");
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function toggle() {
    if (!origin || busy) return;
    setBusy(true);
    try {
      // The permission prompt must be triggered from this click, so it is sent
      // straight from the popup rather than deferred.
      const granted = state === "on"
        ? (await chrome.runtime.sendMessage({ type: "STRIX_SITE_DISABLE", origin }), false)
        : await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
      if (state !== "on" && granted) {
        await chrome.runtime.sendMessage({ type: "STRIX_SITE_ENABLE", origin });
      }
      await refresh();
      // A content script registered just now does not run in an already-open
      // tab, so without this the panel appears only after a manual refresh and
      // the toggle looks broken. Reload so the change takes effect where the
      // user is actually looking.
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) await chrome.tabs.reload(tab.id);
      } catch { /* not fatal: the next navigation picks it up anyway */ }
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return null;
  if (state === "unsupported") return null;

  return (
    <div className="card p-4">
      <div className="label mb-1">Inline terminal</div>
      {state === "builtin" ? (
        <div className="text-[13px] text-white">
          Always on for <span className="font-mono">{host}</span>
        </div>
      ) : (
        <>
          <div className="text-[13px] text-white">
            {state === "on" ? "Running on " : "Not running on "}
            <span className="font-mono">{host}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
            Adds a trade button wherever a token appears on this site, including
            when the address is only in the page URL.
          </p>
          <button
            onClick={toggle}
            disabled={busy}
            className={`mt-3 w-full rounded-xl px-3 py-2 text-[13px] font-semibold transition ${
              state === "on"
                ? "bg-white/10 text-white hover:bg-white/15"
                : "bg-lime text-black hover:bg-lime/90"
            } disabled:opacity-50`}
          >
            {busy ? "…" : state === "on" ? "Turn off here" : "Turn on for this site"}
          </button>
        </>
      )}
    </div>
  );
}

export default function Settings() {
  const { address, toast, lock, reload, go, accounts, chain, activeAddress } = useWallet();
  const [reveal, setReveal] = useState(false);
  const [pw, setPw] = useState("");
  const [secret, setSecret] = useState<{ pk: string; mnemonic?: string; solPk?: string }>();
  const [busy, setBusy] = useState(false);
  const [autoLock, setAutoLock] = useState(15);

  useEffect(() => { getAutoLockMin().then(setAutoLock); }, []);

  async function doReveal(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await ks.revealSecret(pw);
      setSecret(s);
    } catch (err: any) {
      toast("err", err.message || "Wrong password");
    } finally {
      setBusy(false);
    }
  }

  async function wipe() {
    if (!confirm("Remove this wallet from the device? Make sure you have your recovery phrase - this cannot be undone.")) return;
    await ks.wipeWallet();
    toast("info", "Wallet removed");
    await reload();
  }

  return (
    <div>
      <ScreenHeader title="Settings" />
      <div className="space-y-5 p-4">
        <div className="card p-4">
          <div className="label mb-1">Wallet address · {CHAINS[chain].name}</div>
          <div className="break-all font-mono text-[12px] text-white">{activeAddress || "-"}</div>
          <div className="mt-2 flex items-center gap-4 text-[12px]">
            <Copyable text={activeAddress || ""}><span>Copy</span></Copyable>
            <a href={addrUrlOn(chain, activeAddress || "")} target="_blank" rel="noreferrer" className="text-lime hover:underline">
              View on explorer
            </a>
          </div>
        </div>

        <SiteToggle />

        <button onClick={() => go({ name: "accounts" })} className="card flex w-full items-center p-4 text-left transition hover:border-lime/40">
          <div>
            <div className="label mb-1">Accounts</div>
            <div className="text-[13px] text-white">{accounts.length} account{accounts.length === 1 ? "" : "s"} · manage & add</div>
          </div>
          <IconChevronDown className="ml-auto h-4 w-4 -rotate-90 text-muted" />
        </button>

        <div className="card p-4">
          <div className="label mb-2">Auto-lock</div>
          <div className="relative">
            <select
              className="input appearance-none pr-8"
              value={autoLock}
              onChange={async (e) => { const v = Number(e.target.value); setAutoLock(v); await setAutoLockMin(v); toast("ok", "Auto-lock updated"); }}
            >
              {AUTOLOCK_OPTIONS.map((m) => <option key={m} value={m}>{lockLabel(m)}</option>)}
            </select>
            <IconChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          </div>
          <div className="mt-1.5 text-[11px] text-muted">Locks the wallet after this much inactivity.</div>
        </div>

        <div className="card p-4">
          <div className="label mb-1">Network</div>
          <div className="text-[13px] text-white">Robinhood Chain</div>
          <div className="mt-1 text-[11px] text-muted">
            Trading runs entirely inside this extension. No server, no account, keys stay on your device.
          </div>
        </div>

        <div className="card p-4">
          <div className="label mb-2">Security</div>
          {!reveal ? (
            <button className="btn-ghost w-full py-2" onClick={() => setReveal(true)}>
              Reveal recovery phrase / private key
            </button>
          ) : !secret ? (
            <form onSubmit={doReveal} className="space-y-2">
              <input type="password" className="input" placeholder="Confirm password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <button className="btn-primary w-full py-2" disabled={busy}>{busy ? <Spinner /> : "Reveal"}</button>
            </form>
          ) : (
            <div className="space-y-3">
              {secret.mnemonic && (
                <div>
                  <div className="label mb-1">Recovery phrase</div>
                  <div className="rounded-lg border border-danger/30 bg-danger/5 p-2 font-mono text-[12px] text-white">{secret.mnemonic}</div>
                  <Copyable text={secret.mnemonic}><span className="text-[11px]">Copy phrase</span></Copyable>
                </div>
              )}
              <div>
                <div className="label mb-1">Private key (EVM)</div>
                <div className="break-all rounded-lg border border-danger/30 bg-danger/5 p-2 font-mono text-[11px] text-white">{secret.pk}</div>
                <Copyable text={secret.pk}><span className="text-[11px]">Copy key</span></Copyable>
              </div>
              {secret.solPk && (
                <div>
                  <div className="label mb-1">Private key (Solana)</div>
                  <div className="break-all rounded-lg border border-danger/30 bg-danger/5 p-2 font-mono text-[11px] text-white">{secret.solPk}</div>
                  <Copyable text={secret.solPk}><span className="text-[11px]">Copy Solana key</span></Copyable>
                  {/* 64-byte base58 — the format Phantom, Solflare and the CLI
                      import. The bare 32-byte seed looks right and is rejected. */}
                  <div className="mt-1 text-[10.5px] text-muted">
                    Base58 format — paste straight into Phantom or Solflare.
                  </div>
                </div>
              )}
              <div className="text-[11px] text-danger">Never share these. Anyone with them controls your funds.</div>
            </div>
          )}
        </div>

        <button className="btn-ghost w-full" onClick={lock}>Lock wallet</button>
        <button className="btn-danger w-full" onClick={wipe}>Remove wallet from device</button>

        <div className="pt-2 text-center text-[10px] text-muted">Impulse Wallet v{chrome.runtime.getManifest().version} · Robinhood Chain 4663</div>
      </div>
    </div>
  );
}
