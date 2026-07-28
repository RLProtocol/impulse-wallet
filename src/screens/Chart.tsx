import { ScreenHeader, Spinner, useAsync, IconExt } from "../components/ui";
import { bestPair } from "../lib/dexcore";

// A deep, liquid ETH reference pair on Ethereum (Uniswap V3 WETH/USDC 0.05%).
const ETH_PAIR = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";

function embedUrl(chain: string, pair: string) {
  return `https://dexscreener.com/${chain}/${pair}?embed=1&theme=dark&trades=0&info=0&chartTheme=dark`;
}

export default function Chart({ kind, address, symbol }: { kind: "native" | "token" | "stock"; address?: string; symbol?: string }) {
  const q = useAsync(async () => {
    if (kind === "native") return { chain: "ethereum", pair: ETH_PAIR };
    if (!address) return null;
    const p = await bestPair(address);
    const pairAddr = p?.pairAddress;
    return pairAddr ? { chain: "robinhood", pair: pairAddr } : null;
  }, [kind, address]);

  const title = kind === "native" ? "ETH chart" : `${symbol || "Token"} chart`;
  const src = q.data ? embedUrl(q.data.chain, q.data.pair) : null;

  return (
    <div className="flex min-h-[560px] flex-col">
      <ScreenHeader
        title={title}
        right={src ? (
          <a href={src.replace("&embed=1", "").replace("?embed=1", "?")} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-muted hover:text-lime">
            <IconExt />
          </a>
        ) : undefined}
      />
      <div className="relative flex-1">
        {q.loading && <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6 text-lime" /></div>}
        {!q.loading && !src && (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
            No chart is available for this asset yet. It may not have a liquidity pair on Robinhood Chain.
          </div>
        )}
        {src && (
          <iframe
            title={title}
            src={src}
            className="absolute inset-0 h-full w-full border-0"
            allow="clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
