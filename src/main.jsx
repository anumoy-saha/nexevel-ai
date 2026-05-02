import React from "react";
import ReactDOM from "react-dom/client";
import App from "../V2.jsx";

// V2.jsx uses `var CE = React.createElement` without importing React,
// so we expose it globally here.
window.React = React;

ReactDOM.createRoot(document.getElementById("root")).render(
  <App />
);
