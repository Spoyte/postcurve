import type { ReactNode } from "react";
import { Panel } from "./components/Panel";
import { Sidebar } from "./components/Sidebar";
import { useApp } from "./lib/appState";
import { useRoute } from "./lib/route";
import { Setup } from "./screens/Setup";

function NotBuiltYet({ name }: { name: string }) {
  return (
    <Panel>
      <h3>{name}</h3>
      <p className="muted">This screen is being built.</p>
    </Panel>
  );
}

function Shell({ route, children }: { route: string; children: ReactNode }) {
  const { redeployed, dismissRedeployed } = useApp();
  return (
    <div className="shell">
      <Sidebar route={route} unread={0} />
      <main className="main">
        {redeployed && (
          <div className="banner amber">
            <span>The devnet was redeployed: old payments were cleared. Your keys are unchanged.</span>
            <button className="btn ghost" onClick={dismissRedeployed}>
              OK
            </button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export function App() {
  const { store } = useApp();
  const route = useRoute();

  // Bob's window: no sidebar, no access to Alice's screens
  if (route.name === "pay") return <NotBuiltYet name="Pay" />;

  const setUp = !!store.meta;
  if (!setUp) {
    return (
      <Shell route="setup">
        <Setup />
      </Shell>
    );
  }
  return (
    <Shell route={route.name}>
      <NotBuiltYet name={route.name || "postcurve"} />
    </Shell>
  );
}
