import { resetAll } from "../lib/store";

const ITEMS = [
  ["check", "Check"],
  ["receive", "Receive"],
  ["payments", "Payments"],
  ["keys", "Keys"],
  ["canary", "Canary"],
] as const;

export function Sidebar({ route, unread }: { route: string; unread: number }) {
  return (
    <nav className="sidebar">
      <div className="wordmark">
        <i />
        postcurve
      </div>
      {ITEMS.map(([name, label]) => (
        <a key={name} href={`#/${name}`} className={`nav ${route === name || (name === "payments" && route === "spend") ? "on" : ""}`}>
          {label}
          {name === "canary" && unread > 0 && <span className="count">{unread}</span>}
        </a>
      ))}
      <div className="foot">
        <span>local devnet · tUSDC test token</span>
        <button
          className="linkish"
          onClick={() => {
            if (confirm("Reset the demo? This forgets every key and payment in this browser.")) {
              resetAll();
              location.hash = "#/setup";
              location.reload();
            }
          }}
        >
          Reset demo
        </button>
      </div>
    </nav>
  );
}
