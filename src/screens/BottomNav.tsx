import { useWallet, type Screen } from "../state";
import { IconHome, IconChart, IconStock, IconGear } from "../components/ui";

const tabs: { name: Screen["name"]; label: string; icon: any; screen: Screen }[] = [
  { name: "home", label: "Wallet", icon: IconHome, screen: { name: "home" } },
  { name: "trade", label: "Trade", icon: IconChart, screen: { name: "trade" } },
  { name: "stocks", label: "Stocks", icon: IconStock, screen: { name: "stocks" } },
  { name: "settings", label: "Settings", icon: IconGear, screen: { name: "settings" } },
];

export default function BottomNav() {
  const { screen, go } = useWallet();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-[380px] items-stretch border-t border-border bg-surface/95 backdrop-blur">
      {tabs.map((t) => {
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
