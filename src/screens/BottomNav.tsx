import { useWallet, type Screen } from "../state";
import { IconHome, IconChart, IconStock, IconGear, IconTrophy } from "../components/ui";

// Copytrade tab glyph (two figures = follow/copy a trader).
function IconCopyTrade({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M17 9.5V15M14.25 12.25H19.75" />
    </svg>
  );
}

// Popularity tab glyph (a flame = trending).
function IconFlame({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3c1 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1 .3-1.8.8-2.5C9.5 10 10 8 12 3Z" />
      <path d="M12 21a5 5 0 0 0 5-5c0-2-1-3.5-2.2-4.6" />
    </svg>
  );
}

// `chains` limits a tab to where it means something. Tokenised stocks only
// exist on Robinhood Chain, so the tab is hidden elsewhere rather than
// offering trades that cannot settle.
const tabs: { name: Screen["name"]; label: string; icon: any; screen: Screen; chains?: string[] }[] = [
  { name: "home", label: "Wallet", icon: IconHome, screen: { name: "home" } },
  { name: "trade", label: "Trade", icon: IconChart, screen: { name: "trade" } },
  { name: "leaderboard", label: "Ranks", icon: IconTrophy, screen: { name: "leaderboard" } },
  { name: "popularity", label: "Popular", icon: IconFlame, screen: { name: "popularity" } },
  { name: "copytrade", label: "Copy", icon: IconCopyTrade, screen: { name: "copytrade" }, chains: ["robinhood"] },
  { name: "stocks", label: "Stocks", icon: IconStock, screen: { name: "stocks" }, chains: ["robinhood"] },
  { name: "settings", label: "Settings", icon: IconGear, screen: { name: "settings" } },
];

export default function BottomNav() {
  const { screen, go, chain } = useWallet();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-[380px] items-stretch border-t border-border bg-surface/95 backdrop-blur">
      {tabs.filter((t) => !t.chains || t.chains.includes(chain)).map((t) => {
        const active = screen.name === t.name;
        const Icon = t.icon;
        return (
          <button
            key={t.name}
            onClick={() => go(t.screen)}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition ${
              active ? "text-lime" : "text-muted hover:text-white"
            }`}
          >
            <Icon className="h-5 w-5" />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
