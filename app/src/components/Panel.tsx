import type { ReactNode } from "react";

export function Panel({ children, tone, inset, className = "" }: { children: ReactNode; tone?: "ok" | "warn" | "alarm"; inset?: boolean; className?: string }) {
  return <div className={`panel ${tone ?? ""} ${inset ? "inset" : ""} ${className}`}>{children}</div>;
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}
