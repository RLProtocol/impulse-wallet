import { useWallet } from "./state";
import { Logo, Spinner, Toasts } from "./components/ui";
import Onboarding from "./screens/Onboarding";
import Unlock from "./screens/Unlock";
import Home from "./screens/Home";
import Send from "./screens/Send";
import Receive from "./screens/Receive";
import AddToken from "./screens/AddToken";
import Trade from "./screens/Trade";
import Stocks from "./screens/Stocks";
import Asset from "./screens/Asset";
import Settings from "./screens/Settings";
import Accounts from "./screens/Accounts";
import Chart from "./screens/Chart";
import Holders from "./screens/Holders";
import SecurityNotice from "./screens/SecurityNotice";
import BottomNav from "./screens/BottomNav";

export default function App() {
  const { ready, hasWallet, unlocked, needsSecurity, screen } = useWallet();

  if (!ready) {
    return (
      <div className="flex min-h-[560px] flex-col items-center justify-center gap-3">
        <Logo className="h-12 w-12" />
        <Spinner className="h-5 w-5 text-lime" />
      </div>
    );
  }

  if (!hasWallet) return <><Onboarding /><Toasts /></>;
  if (!unlocked) return <><Unlock /><Toasts /></>;
  if (needsSecurity) return <><SecurityNotice /><Toasts /></>;

  const body = (() => {
    switch (screen.name) {
      case "home": return <Home />;
      case "send": return <Send kind={screen.kind} address={screen.address} />;
      case "receive": return <Receive />;
      case "addToken": return <AddToken />;
      case "trade": return <Trade ca={screen.ca} />;
      case "stocks": return <Stocks />;
      case "asset": return <Asset kind={screen.kind} address={screen.address} />;
      case "chart": return <Chart kind={screen.kind} address={screen.address} symbol={screen.symbol} />;
      case "holders": return <Holders ca={screen.ca} symbol={screen.symbol} />;
      case "accounts": return <Accounts />;
      case "settings": return <Settings />;
      default: return <Home />;
    }
  })();

  return (
    <div className="flex min-h-[560px] flex-col pb-16">
      <div className="flex-1">{body}</div>
      <BottomNav />
      <Toasts />
    </div>
  );
}
