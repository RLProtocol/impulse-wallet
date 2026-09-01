import { ScreenHeader, Spinner, useAsync, IconExt } from "../components/ui";
import { bestPair } from "../lib/dexcore";
import { useWallet } from "../state";
import { CHAINS } from "../lib/chains";

// A deep, liquid ETH reference pair on Ethereum (Uniswap V3 WETH/USDC 0.05%).
const ETH_PAIR = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
// Deep SOL/USDC pair on Raydium, for the native chart on Solana.
const SOL_PAIR = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

function embedUrl(chain: string, pair: string) {
  return `https://dexscreener.com/${chain}/${pair}?embed=1&theme=dark&trades=0&info=0&chartTheme=dark`;
}

export default function Chart({ kind, address, symbol }: { kind: "native" | "token" | "stock"; address?: string; symbol?: string }) {
  const { chain } = useWallet();
  const cfg = CHAINS[chain];
  const q = useAsync(async () => {
    // The native chart is always the ETH reference pair on Ethereum, except on
    // Solana where the native asset is SOL and that pair is meaningless.
    if (kind === "native") {
      return cfg.vm === "svm" ? { chain: "solana", pair: SOL_PAIR } : { chain: "ethereum", pair: ETH_PAIR };
    }
    if (!address) return null;
    const p = await bestPair(address, cfg);
    const pairAddr = p?.pairAddress;
    // DexScreener scopes an embed by chain — a Base pair under /robinhood/
    // renders an empty chart, not an error.
    return pairAddr ? { chain: cfg.dexscreener, pair: pairAddr } : null;
  }, [kind, address, chain]);

  const title = kind === "native" ? `${cfg.nativeSymbol} chart` : `${symbol || "Token"} chart`;
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
