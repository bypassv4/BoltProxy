import { URL } from "url";
import { wrapWs, absolutize, shouldProxyResource } from "../utils/shared";

export function rewriteJs(js: string, base: URL): string {
  js = rewriteWebSockets(js, base);
  return js;
}

function rewriteWebSockets(js: string, base: URL): string {
  return js.replace(
    /new\s+WebSocket\s*\(\s*(["'])([^"']+)\1\s*\)/gi,
    (m, quote, rawUrl) => {
      if (!shouldProxyResource(rawUrl)) return m;

      const abs = absolutize(base, rawUrl);
      const proxied = wrapWs(abs);

      return `new WebSocket(${quote}${proxied}${quote})`;
    }
  );
}
