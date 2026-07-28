import { useWallet } from "../state";
import { Spinner, useAsync, IconStock, IconCandle } from "../components/ui";
import { TokenLogo } from "../components/TokenLogo";
import { api } from "../lib/dex";
import { RH_STOCKS } from "../lib/chain";
import { fmtUsd } from "../lib/format";

export default function Stocks() {
  const { go } = useWallet();
  const { data, loading, error } = useAsync(() => api.stocks(), []);

  const priceOf = (addr: string) =>
    data?.stocks.find((s) => s.address.toLowerCase() === addr.toLowerCase())?.priceUsd ?? null;

  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-4">
        <IconStock className="h-5 w-5 text-lime" />
        <h1 className="font-display text-[15px] font-bold tracking-wide text-white">Tokenized Stocks</h1>
      </div>
      <p className="px-4 pt-1 text-[12px] text-muted">Trade stocks on Robinhood Chain, settled in ETH.</p>

      <div className="space-y-1.5 p-4">
        {error && (
          <div className="card p-4 text-center text-[13px] text-muted">
            Prices are momentarily unavailable. Tap a stock to open it and try again.
          </div>
        )}
        {RH_STOCKS.map((s) => {
          const price = priceOf(s.address);
          return (
            <div
              key={s.symbol}
              onClick={() => go({ name: "asset", kind: "stock", address: s.address })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") go({ name: "asset", kind: "stock", address: s.address }); }}
              className="card flex w-full cursor-pointer items-center gap-3 p-3 text-left transition hover:border-lime/40"
            >
              <TokenLogo kind="stock" symbol={s.symbol} address={s.address} size={38} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-white">{s.symbol}</div>
                <div className="truncate text-[11px] text-muted">{s.name}</div>
              </div>
              <div className="text-right text-[13px] font-semibold text-white">
                {loading ? <Spinner className="h-3.5 w-3.5 text-muted" /> : fmtUsd(price)}
              </div>
              <button
                title={`${s.symbol} chart`}
                onClick={(e) => { e.stopPropagation(); go({ name: "chart", kind: "stock", address: s.address, symbol: s.symbol }); }}
                className="shrink-0 rounded-lg border border-border bg-surface2 p-2 text-muted transition hover:border-lime/40 hover:text-lime"
              >
                <IconCandle className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
