import { useState } from "react";
import { USDG } from "../lib/chain";

// Deterministic pleasant color from a symbol, for monogram fallbacks.
const PALETTE = [
  "#a3e635", "#4ade80", "#22d3ee", "#38bdf8", "#818cf8",
  "#c084fc", "#f472b6", "#fb923c", "#facc15", "#2dd4bf",
];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function EthMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="shrink-0">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff">
        <path fillOpacity=".6" d="M16.5 4v8.87l7.49 3.35z" />
        <path d="M16.5 4 9 16.22l7.5-3.35z" />
        <path fillOpacity=".6" d="M16.5 21.97V28L24 17.62z" />
        <path d="M16.5 28v-6.03L9 17.62z" />
        <path fillOpacity=".2" d="m16.5 20.57 7.49-4.35-7.49-3.35z" />
        <path fillOpacity=".6" d="m9 16.22 7.5 4.35v-7.7z" />
      </g>
    </svg>
  );
}

export function UsdgMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="shrink-0">
      <defs>
        <linearGradient id="usdg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22c55e" />
          <stop offset="1" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill="url(#usdg)" />
      <text x="16" y="21" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff" fontFamily="system-ui">
        G$
      </text>
    </svg>
  );
}

function Monogram({ symbol, size }: { symbol: string; size: number }) {
  const label = (symbol || "?").replace(/^\$/, "").slice(0, 3).toUpperCase();
  const bg = colorFor(symbol || "?");
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full font-display font-bold text-[hsl(156_40%_7%)]"
      style={{ width: size, height: size, background: bg, fontSize: Math.max(9, size * 0.34) }}
    >
      {label}
    </div>
  );
}

function RemoteImg({ src, symbol, size }: { src: string; symbol: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Monogram symbol={symbol} size={size} />;
  return (
    <img
      src={src}
      alt={symbol}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-surface2 object-cover"
      style={{ width: size, height: size }}
    />
  );
}

const stockLogo = (symbol: string) =>
  `https://assets.parqet.com/logos/symbol/${symbol.toUpperCase()}?format=png&size=64`;
const dexLogo = (address: string) =>
  `https://dd.dexscreener.com/ds-data/tokens/robinhood/${address.toLowerCase()}.png`;

export type LogoKind = "native" | "token" | "stock";

export function TokenLogo({
  kind,
  symbol,
  address,
  src,
  size = 34,
}: {
  kind: LogoKind;
  symbol: string;
  address?: string;
  src?: string | null; // explicit logo URL (e.g. DexScreener imageUrl)
  size?: number;
}) {
  if (kind === "native") return <EthMark size={size} />;
  if (address && address.toLowerCase() === USDG.toLowerCase()) return <UsdgMark size={size} />;
  if (src) return <RemoteImg src={src} symbol={symbol} size={size} />;
  if (kind === "stock") return <RemoteImg src={stockLogo(symbol)} symbol={symbol} size={size} />;
  if (address) return <RemoteImg src={dexLogo(address)} symbol={symbol} size={size} />;
  return <Monogram symbol={symbol} size={size} />;
}
