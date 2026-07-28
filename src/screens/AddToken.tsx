import { useState } from "react";
import { isAddress, type Address } from "viem";
import { useWallet } from "../state";
import { ScreenHeader, Field, Spinner } from "../components/ui";
import { tokenMeta } from "../lib/wallet";
import { addToken } from "../lib/tokens";
import { fmtUsd } from "../lib/format";
import { api } from "../lib/dex";

export default function AddToken() {
  const { toast, back } = useWallet();
  const [ca, setCa] = useState("");
  const [meta, setMeta] = useState<{ symbol: string; name: string; decimals: number; priceUsd?: number | null }>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const valid = isAddress(ca.trim());

  async function lookup() {
    if (!valid) return;
    setLoading(true);
    setMeta(undefined);
    try {
      const m = await tokenMeta(ca.trim() as Address);
      let priceUsd: number | null | undefined = undefined;
      try {
        const info = await api.tokenInfo(ca.trim());
        priceUsd = info.priceUsd;
      } catch { /* api offline is fine */ }
      setMeta({ ...m, priceUsd });
    } catch (e: any) {
      toast("err", "Could not read token. Check the address.");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!meta) return;
    setSaving(true);
    try {
      await addToken(ca.trim() as Address, "custom", meta);
      toast("ok", `${meta.symbol} added`);
      back();
    } catch (e: any) {
      toast("err", e.message || "Failed to add");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <ScreenHeader title="Add custom token" />
      <div className="space-y-4 p-4">
        <Field label="Token contract address" hint="Any token on Robinhood Chain.">
          <input
            className="input font-mono text-[12px]"
            placeholder="0x…"
            value={ca}
            onChange={(e) => {
              setCa(e.target.value);
              setMeta(undefined);
            }}
          />
        </Field>
        <button className="btn-ghost w-full" disabled={!valid || loading} onClick={lookup}>
          {loading ? <Spinner /> : "Look up token"}
        </button>

        {meta && (
          <div className="card space-y-2 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[15px] font-semibold text-white">{meta.symbol}</div>
                <div className="text-[12px] text-muted">{meta.name}</div>
              </div>
              <div className="text-right">
                <div className="text-[13px] text-white">{fmtUsd(meta.priceUsd ?? null)}</div>
                <div className="text-[11px] text-muted">{meta.decimals} decimals</div>
              </div>
            </div>
            <button className="btn-primary w-full" disabled={saving} onClick={save}>
              {saving ? <Spinner /> : "Add to wallet"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
