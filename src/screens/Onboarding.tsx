import { useState } from "react";
import { useWallet } from "../state";
import { Logo, Spinner, Field, Copyable, IconCopy } from "../components/ui";
import * as ks from "../lib/keystore";

type Mode = "choose" | "create-pw" | "create-seed" | "import";

export default function Onboarding() {
  const { reload, toast } = useWallet();
  const [mode, setMode] = useState<Mode>("choose");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  // import
  const [importKind, setImportKind] = useState<"seed" | "pk">("seed");
  const [secret, setSecret] = useState("");

  const validPw = pw.length >= 8 && pw === pw2;

  async function doCreate() {
    if (!validPw) return;
    setBusy(true);
    try {
      const { mnemonic } = await ks.createWallet(pw);
      setMnemonic(mnemonic);
      setMode("create-seed");
    } catch (e: any) {
      toast("err", e.message || "Failed to create wallet");
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!validPw) return;
    setBusy(true);
    try {
      if (importKind === "seed") await ks.importFromMnemonic(secret, pw);
      else await ks.importFromPrivateKey(secret, pw);
      toast("ok", "Wallet imported");
      await reload();
    } catch (e: any) {
      toast("err", e.message || "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[560px] px-5 py-8">
      <div className="mb-8 flex flex-col items-center text-center">
        <Logo className="h-14 w-14" />
        <h1 className="font-display mt-4 text-xl font-bold tracking-wide text-white">
          IMPULSE <span className="text-lime">WALLET</span>
        </h1>
        <p className="mt-1.5 text-[13px] text-muted">Your gateway to Robinhood Chain</p>
      </div>

      {mode === "choose" && (
        <div className="space-y-3">
          <button className="btn-primary w-full py-4" onClick={() => setMode("create-pw")}>
            Create a new wallet
          </button>
          <button className="btn-ghost w-full py-4" onClick={() => setMode("import")}>
            Import an existing wallet
          </button>
          <p className="pt-2 text-center text-[11px] leading-relaxed text-muted">
            Impulse Wallet is non-custodial. Your keys are encrypted with your password and never
            leave this device.
          </p>
        </div>
      )}

      {mode === "create-pw" && (
        <div className="space-y-4">
          <Field label="Create password" hint="Min 8 characters. Encrypts your wallet on this device.">
            <input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
          </Field>
          <Field label="Confirm password">
            <input type="password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Repeat password" />
          </Field>
          <button className="btn-primary w-full" disabled={!validPw || busy} onClick={doCreate}>
            {busy ? <Spinner /> : "Create wallet"}
          </button>
          <button className="btn-ghost w-full" onClick={() => setMode("choose")}>Back</button>
        </div>
      )}

      {mode === "create-seed" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-lime/30 bg-lime/5 p-3 text-[12px] leading-relaxed text-lime">
            Write down these 12 words in order and keep them safe. They are the ONLY way to recover
            your wallet. Never share them.
          </div>
          <div className="card grid grid-cols-3 gap-2 p-3">
            {mnemonic.split(" ").map((w, i) => (
              <div key={i} className="rounded-lg bg-surface2 px-2 py-2 text-[12px]">
                <span className="mr-1 text-muted">{i + 1}.</span>
                <span className="text-white">{w}</span>
              </div>
            ))}
          </div>
          <Copyable text={mnemonic}>
            <span className="text-[12px]">Copy phrase</span>
          </Copyable>
          <label className="flex items-start gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 accent-lime" />
            I have safely saved my recovery phrase.
          </label>
          <button
            className="btn-primary w-full"
            disabled={!confirmed}
            onClick={async () => {
              toast("ok", "Wallet ready");
              await reload();
            }}
          >
            Open my wallet
          </button>
        </div>
      )}

      {mode === "import" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              className={`flex-1 rounded-lg px-3 py-2 text-[13px] ${importKind === "seed" ? "bg-lime text-black" : "bg-surface2 text-muted"}`}
              onClick={() => setImportKind("seed")}
            >
              Recovery phrase
            </button>
            <button
              className={`flex-1 rounded-lg px-3 py-2 text-[13px] ${importKind === "pk" ? "bg-lime text-black" : "bg-surface2 text-muted"}`}
              onClick={() => setImportKind("pk")}
            >
              Private key
            </button>
          </div>
          <Field label={importKind === "seed" ? "12 / 24-word phrase" : "Private key (0x…)"}>
            <textarea
              className="input h-20 resize-none font-mono text-[12px]"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={importKind === "seed" ? "word1 word2 word3 …" : "0x…"}
            />
          </Field>
          <Field label="Create password" hint="Min 8 characters. Encrypts your wallet on this device.">
            <input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
          </Field>
          <Field label="Confirm password">
            <input type="password" className="input" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Repeat password" />
          </Field>
          <button className="btn-primary w-full" disabled={!validPw || !secret.trim() || busy} onClick={doImport}>
            {busy ? <Spinner /> : "Import wallet"}
          </button>
          <button className="btn-ghost w-full" onClick={() => setMode("choose")}>Back</button>
        </div>
      )}
    </div>
  );
}
