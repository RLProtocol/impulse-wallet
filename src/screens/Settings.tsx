import { useEffect, useState } from "react";
import { useWallet } from "../state";
import { ScreenHeader, Copyable, Spinner, IconChevronDown } from "../components/ui";
import * as ks from "../lib/keystore";
import { addrUrl } from "../lib/chain";
import { getAutoLockMin, setAutoLockMin, AUTOLOCK_OPTIONS } from "../lib/settings";

const lockLabel = (m: number) => (m === 0 ? "Never" : m === 1 ? "1 minute" : `${m} minutes`);

export default function Settings() {
  const { address, toast, lock, reload, go, accounts } = useWallet();
  const [reveal, setReveal] = useState(false);
  const [pw, setPw] = useState("");
  const [secret, setSecret] = useState<{ pk: string; mnemonic?: string }>();
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
          <div className="label mb-1">Wallet address</div>
          <div className="break-all font-mono text-[12px] text-white">{address}</div>
          <div className="mt-2 flex items-center gap-4 text-[12px]">
            <Copyable text={address || ""}><span>Copy</span></Copyable>
            <a href={addrUrl(address || "")} target="_blank" rel="noreferrer" className="text-lime hover:underline">
              View on explorer
            </a>
          </div>
        </div>

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
                <div className="label mb-1">Private key</div>
                <div className="break-all rounded-lg border border-danger/30 bg-danger/5 p-2 font-mono text-[11px] text-white">{secret.pk}</div>
                <Copyable text={secret.pk}><span className="text-[11px]">Copy key</span></Copyable>
              </div>
              <div className="text-[11px] text-danger">Never share these. Anyone with them controls your funds.</div>
            </div>
          )}
        </div>

        <button className="btn-ghost w-full" onClick={lock}>Lock wallet</button>
        <button className="btn-danger w-full" onClick={wipe}>Remove wallet from device</button>

        <div className="pt-2 text-center text-[10px] text-muted">HoodX Wallet v0.1 · Robinhood Chain 4663</div>
      </div>
    </div>
  );
}
