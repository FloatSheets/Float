import { useEffect, useRef, useState } from "react";
import { pages } from "./pages";

export type FloatPage = (typeof pages)[number];

export function findPage(pathname: string): FloatPage {
  const normalized =
    pathname.endsWith("/") || pathname.endsWith(".html") ? pathname : pathname + "/";
  return (
    pages.find((p) => p.route === normalized) ??
    pages.find((p) => p.route === "/404.html")!
  );
}

/** Renders a FloatSheets page: its original markup, stylesheets and interaction scripts. */
export function FloatSheetsPage({ page }: { page: FloatPage }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    document.body.className = page.bodyClass;

    const holder = document.createElement("template");
    holder.innerHTML = page.styles;
    const heads = Array.from(holder.content.children);
    const ready = heads.map(
      (node) =>
        new Promise<void>((resolve, reject) => {
          if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
            node.onload = () => resolve();
            node.onerror = () => reject(new Error("A stylesheet could not load."));
          } else {
            resolve();
          }
          document.head.append(node);
        }),
    );

    let active = true;
    const added: Element[] = [...heads];

    Promise.all(ready)
      .then(async () => {
        if (!active || !host.current) return;
        host.current.innerHTML = page.html;
        for (const url of page.scripts) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.async = false;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("An interaction file could not load."));
            document.body.append(script);
            added.push(script);
          });
        }
        if (!active) return;
        const hash = window.location.hash;
        if (hash && !window.location.pathname.startsWith("/dashboard")) {
          document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
        }
        window.dispatchEvent(new Event("resize"));
      })
      .catch((e: Error) => setError(e.message));

    return () => {
      active = false;
      added.forEach((node) => node.remove());
    };
  }, [page]);

  return (
    <>
      <div ref={host} />
      {error && <p role="alert">{error} Please refresh the page.</p>}
    </>
  );
}
