import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppProvider } from "./lib/appState";
import { loadConfig } from "./lib/config";
import "./theme.css";

const root = createRoot(document.getElementById("root")!);

function OperatorDown({ error }: { error: string }) {
  return (
    <div className="center">
      <div className="panel warn" style={{ maxWidth: 560 }}>
        <h2>The postcurve operator isn't answering</h2>
        <p>The app reads its configuration from the operator, which runs beside the local devnet. Start both with:</p>
        <div className="box">cd app && bun run dev</div>
        <p className="muted mono">{error}</p>
        <div>
          <button className="btn ghost" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

loadConfig()
  .then((cfg) =>
    root.render(
      <StrictMode>
        <AppProvider cfg={cfg}>
          <App />
        </AppProvider>
      </StrictMode>,
    ),
  )
  .catch((e) => root.render(<OperatorDown error={e instanceof Error ? e.message : String(e)} />));
