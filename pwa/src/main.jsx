import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, err: null };
  }
  static getDerivedStateFromError(err) {
    return { hasError: true, err };
  }
  componentDidCatch(err, info) {
    console.error("UI Crash:", err, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, fontFamily: "system-ui" }}>
          <h3 style={{ margin: 0, marginBottom: 8 }}>Ops. A interface quebrou.</h3>
          <pre style={{ whiteSpace: "pre-wrap", background: "#111", color: "#fff", padding: 12, borderRadius: 10 }}>
            {String(this.state.err?.stack || this.state.err?.message || this.state.err)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 12, padding: "10px 14px", border: "1px solid #111", borderRadius: 10, cursor: "pointer" }}
          >
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// anti-tradução/DOM-mutation
document.documentElement.setAttribute("translate", "no");
document.documentElement.classList.add("notranslate");
document.documentElement.lang = "pt-BR";

ReactDOM.createRoot(document.getElementById("root")).render(
  // ✅ sem StrictMode no mobile DEV (ele desmonta/monta duas vezes e piora essas tretas)
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
