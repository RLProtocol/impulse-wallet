import { useState } from "react";
import { useWallet } from "../state";
import { ScreenHeader, Field, Spinner, Copyable, IconPlus } from "../components/ui";
import * as ks from "../lib/keystore";
import { shortAddr } from "../lib/format";
import owl from "../assets/owl.png";

export function AccountAvatar({ address, size = 34 }: { address: string; size?: number }) {
  // HoodX owl on a subtle per-account tint so accounts stay distinguishable.
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full"
      style={{ width: size, height: size, background: `hsl(${hue} 40% 16%)`, border: `1px solid hsl(${hue} 55% 40%)` }}
    >
      <img src={owl} alt="" style={{ width: size * 0.64, height: size * 0.64 }} />
    </div>
  );
}

export default function Accounts() {
  const { accounts, activeId, switchAccount, refresh, toast, back } = useWallet();
  const [mode, setMode] = useState<"list" | "import">("list");
  const [importKind, setImportKind] = useState<"pk" | "seed">("pk");
  const [secret, setSecret] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  async function addHd() {
    setBusy(true);
    try {
      await ks.addHdAccount();
      await refresh();
      toast("ok", "Account added");
    } catch (e: any) {
      toast("err", e.message || "Could not add account");
    } finally { setBusy(false); }
  }

  async function doImport() {
    setBusy(true);
    try {
      await ks.addImportedAccount(secret, pw, importKind);
      await refresh();
      toast("ok", "Account imported");
      setMode("list"); setSecret(""); setPw("");
    } catch (e: any) {
      toast("err", e.message || "Import failed");
    } finally { setBusy(false); }
  }

  async function saveLabel(id: string) {
    await ks.renameAccount(id, label);
    setEditing(null);
    await refresh();
  }

  async function remove(id: string) {
    if (!confirm("Remove this account from the wallet? HD accounts can be re-derived from your recovery phrase; imported ones need re-importing.")) return;
    try {
      await ks.removeAccount(id);
      await refresh();
      toast("info", "Account removed");
    } catch (e: any) {
      toast("err", e.message || "Could not remove");
    }
  }

  if (mode === "import") {
    return (
      <div>
        <ScreenHeader title="Import account" />
        <div className="space-y-4 p-4">
          <div className="flex gap-2">
            <button className={`flex-1 rounded-lg px-3 py-2 text-[13px] ${importKind === "pk" ? "bg-lime text-black" : "bg-surface2 text-muted"}`} onClick={() => setImportKind("pk")}>Private key</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-[13px] ${importKind === "seed" ? "bg-lime text-black" : "bg-surface2 text-muted"}`} onClick={() => setImportKind("seed")}>Recovery phrase</button>
          </div>
          <Field label={importKind === "pk" ? "Private key (0x…)" : "Recovery phrase"}>
            <textarea className="input h-20 resize-none font-mono text-[12px]" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={importKind === "pk" ? "0x…" : "word1 word2 …"} />
          </Field>
          <Field label="Wallet password" hint="Confirm your password to encrypt this account on the device.">
            <input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
          </Field>
          <button className="btn-primary w-full" disabled={busy || !secret.trim() || !pw} onClick={doImport}>{busy ? <Spinner /> : "Import"}</button>
          <button className="btn-ghost w-full" onClick={() => setMode("list")}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader title="Accounts" />
      <div className="space-y-2 p-4">
        {accounts.map((a) => (
          <div key={a.id} className={`card p-3 ${a.id === activeId ? "border-lime/50" : ""}`}>
            <div className="flex items-center gap-3">
              <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => a.id !== activeId && switchAccount(a.id)}>
                <AccountAvatar address={a.address} />
                <div className="min-w-0 flex-1">
                  {editing === a.id ? (
                    <input autoFocus className="input py-1 text-[13px]" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => saveLabel(a.id)} onKeyDown={(e) => e.key === "Enter" && saveLabel(a.id)} />
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[14px] font-semibold text-white">{a.label}</span>
                      {a.kind === "imported" && <span className="chip px-1.5 py-0 text-[9px]">imported</span>}
                      {a.id === activeId && <span className="chip border-lime/40 px-1.5 py-0 text-[9px] text-lime">active</span>}
                    </div>
                  )}
                  <div className="truncate font-mono text-[11px] text-muted">{shortAddr(a.address, 6)}</div>
                </div>
              </button>
              <div className="flex items-center gap-2 text-muted">
                <Copyable text={a.address}><span className="sr-only">copy</span></Copyable>
                <button className="text-[11px] hover:text-white" onClick={() => { setEditing(a.id); setLabel(a.label); }}>Rename</button>
                {accounts.length > 1 && <button className="text-[11px] hover:text-danger" onClick={() => remove(a.id)}>Remove</button>}
              </div>
            </div>
          </div>
        ))}

        <button className="btn-primary mt-3 w-full" disabled={busy} onClick={addHd}>
          {busy ? <Spinner /> : <><IconPlus className="h-4 w-4" /> Add account</>}
        </button>
        <button className="btn-ghost w-full" onClick={() => setMode("import")}>Import a private key / phrase</button>
        <p className="pt-1 text-center text-[11px] text-muted">
          New accounts derive from your recovery phrase, so one backup covers them all.
        </p>
      </div>
    </div>
  );
}
