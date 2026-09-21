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

/** Below-the-fold images load lazily so the first screen paints sooner. */
const preparedHtml = new Map<string, string>();
function prepare(page: FloatPage) {
  const cached = preparedHtml.get(page.route);
  if (cached) return cached;
  let seen = 0;
  const html = page.html.replace(/<img\b(?![^>]*\bloading=)/g, () => {
    seen += 1;
    return seen <= 6 ? '<img decoding="async"' : '<img loading="lazy" decoding="async"';
  });
  preparedHtml.set(page.route, html);
  return html;
}

/** Renders a FloatSheets page: its original markup, stylesheets and interaction scripts. */
export function FloatSheetsPage({ page }: { page: FloatPage }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    document.body.className = page.bodyClass;

    const holder = document.createElement("template");
    holder.innerHTML = page.styles;
    const heads = Array.from(holder.content.children).filter(
      (node) => !(node instanceof HTMLLinkElement && node.rel === "icon"),
    );
    const loaded = heads.map(
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

    // Insert the markup right away (hidden) so images and fonts fetch in
    // parallel with the stylesheets instead of after them.
    if (host.current) host.current.innerHTML = prepare(page);

    Promise.all(loaded)
      .then(async () => {
        if (!active) return;
        setReady(true);
        await Promise.all(
          page.scripts.map(
            (url) =>
              new Promise<void>((resolve, reject) => {
                const script = document.createElement("script");
                script.src = url;
                script.async = false;
                script.onload = () => resolve();
                script.onerror = () =>
                  reject(new Error("An interaction file could not load."));
                document.body.append(script);
                added.push(script);
              }),
          ),
        );
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
      setReady(false);
      added.forEach((node) => node.remove());
    };
  }, [page]);

  return (
    <>
      <div
        ref={host}
        style={{
          opacity: ready ? 1 : 0,
          transition: "opacity 220ms ease-out",
        }}
      />
      {error && <p role="alert">{error} Please refresh the page.</p>}
    </>
  );
}

