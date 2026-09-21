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

/** Script files are fetched once and shared between page mounts. */
const scriptCache = new Map<string, Promise<string>>();
function loadScript(url: string) {
  let code = scriptCache.get(url);
  if (!code) {
    code = fetch(url).then((res) => {
      if (!res.ok) throw new Error("An interaction file could not load.");
      return res.text();
    });
    scriptCache.set(url, code);
  }
  return code;
}

/** Renders a FloatSheets page: its original markup, stylesheets and interaction scripts. */
export function FloatSheetsPage({ page }: { page: FloatPage }) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"hidden" | "fading" | "done">("hidden");
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
    let fadeTimer: ReturnType<typeof setTimeout>;
    const added: Element[] = [...heads];


    // Insert the markup right away (hidden) so images and fonts fetch in
    // parallel with the stylesheets instead of after them.
    if (host.current) host.current.innerHTML = prepare(page);

    Promise.all(loaded)
      .then(async () => {
        if (!active) return;
        setPhase("fading");
        fadeTimer = setTimeout(() => setPhase("done"), 260);

        // A page's scripts share one scope (dashboard.js uses helpers from
        // app.js), so they are joined and run as a single wrapped script —
        // this also makes re-mounts safe instead of re-declaring globals.
        const codes = await Promise.all(page.scripts.map(loadScript));
        if (!active) return;
        const script = document.createElement("script");
        script.textContent = `(function(){\n${codes.join("\n;\n")}\n})();`;
        document.body.append(script);
        added.push(script);
        const hash = window.location.hash;
        if (hash && !window.location.pathname.startsWith("/dashboard")) {
          document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
        }
        window.dispatchEvent(new Event("resize"));
      })
      .catch((e: Error) => setError(e.message));

    return () => {
      active = false;
      clearTimeout(fadeTimer);
      setPhase("hidden");

      added.forEach((node) => node.remove());
    };
  }, [page]);

  return (
    <>
      <div
        ref={host}
        // Once the fade finishes the inline style is dropped entirely, so it
        // never creates a stacking context for fixed elements.
        style={
          phase === "done"
            ? undefined
            : { opacity: phase === "hidden" ? 0 : 1, transition: "opacity 220ms ease-out" }
        }
      />

      {error && <p role="alert">{error} Please refresh the page.</p>}
    </>
  );
}

