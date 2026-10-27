import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL =
  `${import.meta.env.BASE_URL}cesium/`;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
