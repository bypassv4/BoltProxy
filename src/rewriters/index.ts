import { rewriteHtml } from "./html";
import { rewriteJs } from "./js";
import { rewriteCss } from "./css";

export { rewriteHtml, rewriteJs, rewriteCss };

export const Rewriters = {
  html: rewriteHtml,
  js: rewriteJs,
  css: rewriteCss,
};

export type RewriterType = keyof typeof Rewriters;
