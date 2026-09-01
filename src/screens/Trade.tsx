import { useState } from "react";
import { isAddress } from "viem";
import { isSolAddress } from "../lib/solana";
import { useWallet } from "../state";
import { Field, IconChart } from "../components/ui";
import TradePanel from "../components/TradePanel";

export default function Trade({ ca }: { ca?: string }) {
  const { go } = useWallet();
  const [input, setInput] = useState(ca || "");
  // Accept an EVM contract or a Solana mint — the chain is worked out from
  // the address itself, so the user never has to say which one it is.
  const looksLikeToken = (v: string) => isAddress(v) || isSolAddress(v);
  const [active, setActive] = useState<string | undefined>(
    ca && looksLikeToken(ca) ? ca : undefined,
  );
  const valid = looksLikeToken(input.trim());

  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-4">
        <IconChart className="h-5 w-5 text-lime" />
        <h1 className="font-display text-[15px] font-bold tracking-wide text-white">Trade</h1>
        <span className="chip ml-auto border-lime/30 text-lime">RH · ETH · BASE</span>
      </div>

      <div className="space-y-4 p-4">
        <Field label="Paste any token address" hint="Robinhood Chain, Ethereum or Base - we detect the chain, route the best venue, and add it to your wallet.">
          <div className="flex gap-2">
            <input
              className="input font-mono text-[12px]"
              placeholder="0x…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) setActive(input.trim());
              }}
            />
            <button
              className="btn-primary shrink-0 px-4"
              disabled={!valid}
              onClick={() => setActive(input.trim())}
            >
              Scan
            </button>
          </div>
        </Field>

        {active ? (
          <TradePanel key={active} ca={active} />
        ) : (
          <div className="card p-6 text-center">
            <IconChart className="mx-auto h-8 w-8 text-lime/60" />
            <p className="mt-3 text-[13px] text-muted">
              Paste a contract address from Robinhood Chain, Ethereum or Base to see price,
              liquidity and a one-tap buy. The chain is detected automatically.
            </p>
            <button className="mt-4 text-[12px] text-lime hover:underline" onClick={() => go({ name: "stocks" })}>
              Or browse tokenized stocks →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
