import { URL } from "url";

export const NON_PROXY_SCHEMES = /^(?:data|javascript|mailto|tel|blob):/i;

export function wrap(url: string) {
  return "/proxy?url=" + encodeURIComponent(url);
}

export function wrapWs(url: string) {
  return "/proxy_ws?url=" + encodeURIComponent(url);
}

export function shouldProxyResource(raw?: string | null): boolean {
  if (!raw) return false;
  const v = raw.trim();
  if (!v) return false;
  if (v.startsWith("#")) return false;
  return !NON_PROXY_SCHEMES.test(v);
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
