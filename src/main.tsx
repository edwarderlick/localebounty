import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { DemoProvider } from "./data/DemoContext";
import { WalletProvider } from "./live/WalletContext";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <DemoProvider>
          <App />
        </DemoProvider>
      </WalletProvider>
    </BrowserRouter>
  </StrictMode>,
);
