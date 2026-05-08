import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { migrateLegacyStorage } from "./services/storageMigration";
import "./index.css";

migrateLegacyStorage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
