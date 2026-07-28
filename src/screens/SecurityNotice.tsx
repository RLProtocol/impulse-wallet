import { useState } from "react";
import { useWallet } from "../state";
import { Owl, IconShield } from "../components/ui";
import { setSecurityAck } from "../lib/settings";

const POINTS = [
  { t: "Back up your recovery phrase", d: "It's the only way to restore your wallet. Write it down offline and never share it. Anyone with it owns your funds." },
  { t: "Use a strong password", d: "Your keys are encrypted with it on this device. A weak password is the weak link. No one can reset it for you." },
  { t: "This is a hot wallet", d: "Keys live in your browser while unlocked. For large amounts, use a hardware wallet. Keep only what you trade here." },
  { t: "Non-custodial", d: "We never see your keys and can't move your funds or recover your password. You are in full control." },
];

export default function SecurityNotice() {
  const { ackSecurity, toast } = useWallet();
  const [checked, setChecked] = useState(false);

  return (
    <div className="min-h-[560px] px-5 py-8">
      <div className="mb-6 flex flex-col items-center text-center">
        <Owl className="h-12 w-12" />
        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-lime/30 bg-lime/10 px-3 py-1 text-[11px] text-lime">
          <IconShield className="h-3.5 w-3.5" /> Before you start
        </div>
        <h1 className="font-display mt-3 text-xl font-bold text-white">Keep your wallet safe</h1>
      </div>

      <div className="space-y-3">
        {POINTS.map((p) => (
          <div key={p.t} className="card p-3.5">
            <div className="text-[13px] font-semibold text-white">{p.t}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-muted">{p.d}</div>
          </div>
        ))}
      </div>

      <label className="mt-5 flex items-start gap-2 text-[12px] text-muted">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 accent-lime" />
        I understand I'm responsible for my recovery phrase and password.
      </label>

      <button
        className="btn-primary mt-4 w-full"
        disabled={!checked}
        onClick={async () => {
          await setSecurityAck(true);
          ackSecurity();
          toast("ok", "You're all set");
        }}
      >
        Enter wallet
      </button>
    </div>
  );
}
