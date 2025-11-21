import { URL } from "url";

const NON_PROXY_SCHEMES = /^(?:data|javascript|mailto|tel|blob):/i;

function wrap(url: string) {
  return "/proxy?url=" + encodeURIComponent(url);
}

function absolutize(base: URL, raw: string) {
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
