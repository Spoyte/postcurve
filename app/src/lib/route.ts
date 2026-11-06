import { useEffect, useState } from "react";

export type Route = { name: string; arg?: string; query: URLSearchParams };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const [path = "", qs = ""] = h.split("?");
  const [name = "", arg] = path.split("/");
  return { name, arg, query: new URLSearchParams(qs) };
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return parseRoute(hash);
}

export const go = (hash: string) => {
  location.hash = hash;
};
