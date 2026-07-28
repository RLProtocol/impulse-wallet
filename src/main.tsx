import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WalletProvider } from "./state";
import "./index.css";

// If opened as a full tab (onboarding / expanded view), stretch the layout.
if (new URLSearchParams(location.search).get("expanded") === "1") {
  document.body.classList.add("expanded");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WalletProvider>
      <App />
    </WalletProvider>
  </React.StrictMode>,
);
