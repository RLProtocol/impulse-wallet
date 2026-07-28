import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useWallet } from "../state";
import { ScreenHeader, Copyable } from "../components/ui";

export default function Receive() {
  const { address, toast } = useWallet();
  const [qr, setQr] = useState<string>();

  useEffect(() => {
    if (!address) return;
    QRCode.toDataURL(address, {
      margin: 1,
      width: 220,
      color: { dark: "#0d140f", light: "#a3e635" },
    }).then(setQr);
  }, [address]);

  return (
    <div>
      <ScreenHeader title="Receive" />
      <div className="flex flex-col items-center px-6 py-6">
        <div className="rounded-2xl bg-lime p-3 shadow-glow">
          {qr && <img src={qr} alt="address QR" className="h-52 w-52 rounded-lg" />}
        </div>
        <p className="mt-5 text-center text-[13px] text-muted">
          Your Robinhood Chain address. Send only assets on{" "}
          <span className="text-lime">Robinhood Chain (ETH, stocks, tokens)</span> here.
        </p>
        <div className="mt-4 w-full rounded-xl border border-border bg-surface2 p-3">
          <div className="break-all text-center font-mono text-[12px] text-white">{address}</div>
        </div>
        <button
          className="btn-primary mt-4 w-full"
          onClick={() => {
            navigator.clipboard.writeText(address || "");
            toast("ok", "Address copied");
          }}
        >
          Copy address
        </button>
        <div className="mt-3">
          <Copyable text={address || ""}>
            <span className="text-[12px]">Copy again</span>
          </Copyable>
        </div>
      </div>
    </div>
  );
}
