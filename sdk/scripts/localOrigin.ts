// Which web pages may call postcurve's local services (the device bridge, the operator). Writes need
// an app origin; reads may come without an Origin (browsers omit it on same-origin GETs) but never
// from a foreign page. Extra origins, such as the public tunnel URL, come from POSTCURVE_APP_ORIGINS.

export const APP_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

export function appOrigins(): string[] {
  const extra = (process.env.POSTCURVE_APP_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return [...APP_ORIGINS, ...extra];
}

export function originAllowed(method: string, origin: string | null): boolean {
  if (origin === null) return method === "GET" || method === "HEAD";
  return appOrigins().includes(origin);
}
