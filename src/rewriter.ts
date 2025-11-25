import { URL } from "url";

const NON_PROXY_SCHEMES = /^(?:data|javascript|mailto|tel|blob):/i;
const PROXY_PREFIX = "/proxy?url=";
const PROXY_POST_PREFIX = "/post?url=";

export function wrap(url: string, method?: string) {
  const upper = method ? method.trim().toUpperCase() : "";
  const prefix = upper === "POST" ? PROXY_POST_PREFIX : PROXY_PREFIX;
  return prefix + encodeURIComponent(url);
}

// NEW: dedicated wrapper for websocket endpoints
export function wrapWs(url: string) {
  return "/proxy_ws?url=" + encodeURIComponent(url);
}

export function absolutize(base: URL, raw: string) {
  const value = raw.trim();
  if (!value) return value;
  if (NON_PROXY_SCHEMES.test(value)) return value;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return base.protocol + value;
  if (value.startsWith("/")) return base.origin + value;
  return new URL(value, base).href;
}

function shouldProxyResource(raw: string | undefined | null) {
  if (!raw) return false;
  const v = raw.trim();
  if (!v) return false;
  if (v.startsWith("#")) return false;
  return !NON_PROXY_SCHEMES.test(v);
}

function rewriteHtmlAttributes(html: string, base: URL): string {
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
      html = html.replace(re, (match, prefix, quote, value) => {
        if (!shouldProxyResource(value)) return match;
        const abs = absolutize(base, value);
        let method: string | undefined;
        if (spec.tag === "form" && attr === "action") {
          const methodMatch = match.match(/\bmethod\s*=\s*["']?([a-z]+)/i);
          method = methodMatch ? methodMatch[1] : undefined;
        }
        return `${prefix}${quote}${wrap(abs, method)}${quote}`;
      });
    }
  }

  return html;
}

function injectRuntime(html: string, base: URL): string {
  const injection =
    `<script>window.__proxy_target=${JSON.stringify(base.href)};</script>` +
    `<script src="/runtime.js"></script>`;

  if (html.toLowerCase().includes("</head>")) {
    return html.replace(/<\/head>/i, injection + "</head>");
  }
  if (html.toLowerCase().includes("<body")) {
    return html.replace(/<body[^>]*>/i, (m) => m + injection);
  }
  return injection + html;
}

/**
 * HTML rewriter: inject runtime + rewrite element attrs.
 */
export function rewriteHtml(html: string, base: URL): string {
  html = rewriteHtmlAttributes(html, base);
  html = injectRuntime(html, base);
  return html;
}

/**
 * JS rewriter:
 * - keep as-is for most code
 * - PLUS rewrite literal WebSocket("wss://…") calls to go through /proxy_ws
 */
export function rewriteJs(js: string, base: URL): string {
  // Rewrite: new WebSocket("wss://example.com/…")
  js = js.replace(
    /new\s+WebSocket\s*\(\s*(["'])([^"']+)\1\s*\)/gi,
    (match, quote, rawUrl) => {
      const cleaned = String(rawUrl || "").trim();
      if (!shouldProxyResource(cleaned)) return match;

      const abs = absolutize(base, cleaned);
      const proxied = wrapWs(abs);

      return `new WebSocket(${quote}${proxied}${quote})`;
    }
  );

  return js;
}

/**
 * CSS rewriter: rewrite url(...) + @import only.
 */
export function rewriteCss(css: string, base: URL): string {
  // url(...)
  css = css.replace(
    /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi,
    (_m, _quote, rawUrl) => {
      const cleaned = String(rawUrl || "").trim();
      if (!shouldProxyResource(cleaned)) {
        return `url(${cleaned})`;
      }
      const abs = absolutize(base, cleaned);
      return `url("${wrap(abs)}")`;
    }
  );

  // @import url("...")
  css = css.replace(
    /@import\s+(?:url\()?['"]?([^"')]+)['"]?\)?/gi,
    (_m, rawUrl) => {
      if (!shouldProxyResource(rawUrl)) {
        return `@import url(${rawUrl})`;
      }
      const abs = absolutize(base, rawUrl);
      return `@import url("${wrap(abs)}")`;
    }
  );

  return css;
}
