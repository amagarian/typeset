import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { migrateLegacyStorage } from "./services/storageMigration";
import "./index.css";

// v0.5.37 — model + accuracy preferences are no longer persisted
// (see services/geminiSettings.ts), so the prior `migrateLegacy*`
// shims are gone. Any leftover localStorage keys from v0.5.36 are
// orphaned but harmless.
migrateLegacyStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
