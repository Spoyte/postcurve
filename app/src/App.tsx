import type { ReactNode } from "react";
import { Panel } from "./components/Panel";
import { Sidebar } from "./components/Sidebar";
import { useApp } from "./lib/appState";
import { useRoute } from "./lib/route";
import { Pay } from "./screens/Pay";
import { Payments } from "./screens/Payments";
import { Receive } from "./screens/Receive";
import { Setup } from "./screens/Setup";
import { AlertBar, useUnreadAlerts } from "./components/AlertBar";
import { Canary } from "./screens/Canary";
import { Device } from "./screens/Device";
import { Keys } from "./screens/Keys";
import { Spend } from "./screens/Spend";

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
  const unread = useUnreadAlerts();
  return (
    <div className="shell">
      <Sidebar route={route} unread={unread} />
      <main className="main">
        <AlertBar />
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
  if (route.name === "pay") return <Pay />;
  if (route.name === "device") return <Device pair={route.query.get("pair") ?? ""} />;

  const setUp = !!store.meta;
  if (!setUp) {
    return (
      <Shell route="setup">
        <Setup />
      </Shell>
    );
  }
  const screens: Record<string, () => ReactNode> = {
    receive: () => <Receive />,
    payments: () => <Payments />,
    spend: () => <Spend account={route.arg ?? ""} />,
    keys: () => <Keys />,
    canary: () => <Canary />,
  };
  const screen = screens[route.name];
  return <Shell route={route.name || "receive"}>{screen ? screen() : route.name ? <NotBuiltYet name={route.name} /> : <Receive />}</Shell>;
}
