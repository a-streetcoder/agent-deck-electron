import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installSystemTheme } from "./lib/systemTheme.ts";
import { connectAndBootstrap } from "./state/wsBridge.ts";
import "./index.css";

installSystemTheme();
connectAndBootstrap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
