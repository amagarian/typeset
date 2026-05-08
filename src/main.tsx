import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { migrateLegacyStorage } from "./services/storageMigration";
import {
  migrateLegacyModelPreference,
  migrateLegacyAccuracyPreference,
} from "./services/geminiSettings";
import "./index.css";

migrateLegacyStorage();
migrateLegacyModelPreference();
migrateLegacyAccuracyPreference();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
