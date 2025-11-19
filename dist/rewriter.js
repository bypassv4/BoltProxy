"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrap = wrap;
exports.absolutize = absolutize;
exports.rewriteHtml = rewriteHtml;
exports.rewriteJs = rewriteJs;
exports.rewriteCss = rewriteCss;
const url_1 = require("url");
const NON_PROXY_SCHEMES = /^(?:data|javascript|mailto|tel|blob):/i;
function wrap(url) {
    return "/proxy?url=" + encodeURIComponent(url);
}
function absolutize(base, raw) {
    const value = raw.trim();
    if (!value)
        return value;
    if (NON_PROXY_SCHEMES.test(value))
        return value;
    if (value.startsWith("http://") || value.startsWith("https://"))
        return value;
    if (value.startsWith("//"))
        return base.protocol + value;
    if (value.startsWith("/"))
        return base.origin + value;
    return new url_1.URL(value, base).href;
}
function shouldProxyResource(raw) {
    if (!raw)
        return false;
    const v = raw.trim();
    if (!v)
        return false;
    if (v.startsWith("#"))
        return false;
    return !NON_PROXY_SCHEMES.test(v);
}
function rewriteHtmlAttributes(html, base) {
    const specs = [
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
            const re = new RegExp(`(<${spec.tag}\\b[^>]*?\\s${attr}\\s*=\\s*)(["'])([^"']*?)\\2`, "gi");
            html = html.replace(re, (match, prefix, quote, value) => {
                if (!shouldProxyResource(value))
                    return match;
                const abs = absolutize(base, value);
                return `${prefix}${quote}${wrap(abs)}${quote}`;
            });
        }
    }
    return html;
}
function injectRuntime(html, base) {
    const injection = `<script>window.__proxy_target=${JSON.stringify(base.href)};</script>` +
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
function rewriteHtml(html, base) {
    html = rewriteHtmlAttributes(html, base);
    html = injectRuntime(html, base);
    return html;
}
/**
 * JS rewriter: conservative – runtime.js does the heavy lifting.
 */
function rewriteJs(js, _base) {
    return js;
}
/**
 * CSS rewriter: rewrite url(...) + @import only.
 */
function rewriteCss(css, base) {
    // url(...)
    css = css.replace(/url\(\s*(['"]?)([^"')]+)\1\s*\)/gi, (_m, _quote, rawUrl) => {
        const cleaned = String(rawUrl || "").trim();
        if (!shouldProxyResource(cleaned)) {
            return `url(${cleaned})`;
        }
        const abs = absolutize(base, cleaned);
        return `url("${wrap(abs)}")`;
    });
    // @import url("...")
    css = css.replace(/@import\s+(?:url\()?['"]?([^"')]+)['"]?\)?/gi, (_m, rawUrl) => {
        if (!shouldProxyResource(rawUrl)) {
            return `@import url(${rawUrl})`;
        }
        const abs = absolutize(base, rawUrl);
        return `@import url("${wrap(abs)}")`;
    });
    return css;
}
