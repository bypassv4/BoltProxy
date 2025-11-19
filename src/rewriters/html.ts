import { URL } from "url";
import { wrap, absolutize, shouldProxyResource } from "../utils/shared";

export function rewriteHtml(html: string, base: URL): string {
  html = rewriteAttributes(html, base);
  html = injectRuntime(html, base);
  return html;
}

function rewriteAttributes(html: string, base: URL): string {
  type AttrSpec = { tag: string; attrs: string[] };

  const specs: AttrSpec[] = [
    { tag: "a", attrs: ["href"] },
    { tag: "link", attrs: ["href"] },
    { tag: "img", attrs: ["src", "srcset"] },
    { tag: "script", attrs: ["src"] },
    { tag: "iframe", attrs: ["src"] },
    { tag: "form", attrs: ["action"] },
    { tag: "video", attrs: ["src", "poster"] },
    { tag: "audio", attrs: ["src"] },
    { tag: "source", attrs: ["src", "srcset"] },
    { tag: "track", attrs: ["src"] }
  ];

  for (const spec of specs) {
    for (const attr of spec.attrs) {
      const re = new RegExp(
        `(<${spec.tag}\\b[^>]*?\\s${attr}\\s*=\\s*)(["'])([^"']*?)\\2`,
        "gi"
      );
      html = html.replace(re, (m, prefix, quote, value) => {
        if (!shouldProxyResource(value)) return m;

        const abs = absolutize(base, value);
        return `${prefix}${quote}${wrap(abs)}${quote}`;
      });
    }
  }

  return html;
}

function injectRuntime(html: string, base: URL): string {
  const script =
    `<script>window.__proxy_target=${JSON.stringify(base.href)};</script>` +
    `<script src="/runtime.js"></script>`;

  if (html.toLowerCase().includes("</head>")) {
    return html.replace(/<\/head>/i, script + "</head>");
  }

  if (html.toLowerCase().includes("<body")) {
    return html.replace(/<body[^>]*>/i, (m) => m + script);
  }

  return script + html;
}
