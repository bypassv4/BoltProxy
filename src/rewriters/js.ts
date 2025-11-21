import { URL } from "url";

// For now, JS is passed through. You can add transforms later.
export function rewriteJs(js: string, _base: URL): string {
  return js;
}
