import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { migrateLegacyStorage } from "./services/storageMigration";
import { migrateLegacyModelPreference } from "./services/geminiSettings";
import "./index.css";

migrateLegacyStorage();
migrateLegacyModelPreference();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
