import { useState } from "react";
import { useWallet } from "../state";
import { Owl, Spinner } from "../components/ui";
import * as ks from "../lib/keystore";

export default function Unlock() {
  const { reload, toast } = useWallet();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await ks.unlock(pw);
      await reload();
    } catch (err: any) {
      toast("err", err.message || "Wrong password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[560px] flex-col items-center justify-center px-6">
      <Owl className="h-16 w-16" />
      <h1 className="font-display mt-5 text-lg font-bold tracking-wide text-white">
        Welcome back
      </h1>
      <p className="mt-1 text-[13px] text-muted">Unlock your HoodX Wallet</p>
      <form onSubmit={submit} className="mt-6 w-full space-y-3">
        <input
          type="password"
          autoFocus
          className="input text-center"
          placeholder="Password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button type="submit" className="btn-primary w-full" disabled={busy || !pw}>
          {busy ? <Spinner /> : "Unlock"}
        </button>
      </form>
    </div>
  );
}
