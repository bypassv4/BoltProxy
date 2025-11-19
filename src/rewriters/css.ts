import { URL } from "url";
import { wrap, absolutize, shouldProxyResource } from "../utils/shared";

export function rewriteCss(css: string, base: URL): string {
  css = css.replace(
    /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi,
    (_m, _q, raw) => {
      const cleaned = raw.trim();
      if (!shouldProxyResource(cleaned)) return `url(${cleaned})`;

      const abs = absolutize(base, cleaned);
      return `url("${wrap(abs)}")`;
    }
  );

  css = css.replace(
    /@import\s+(?:url\()?['"]?([^"')]+)['"]?\)?/gi,
    (_m, raw) => {
      if (!shouldProxyResource(raw)) return `@import url(${raw})`;

      const abs = absolutize(base, raw);
      return `@import url("${wrap(abs)}")`;
    }
  );

  return css;
}
