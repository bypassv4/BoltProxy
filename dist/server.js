"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const ws_1 = __importDefault(require("ws"));
const rewriters_1 = require("./rewriters");
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT || 8080);
app.use(express_1.default.raw({
    type: "*/*",
    limit: "25mb"
}));
const httpAgent = new http_1.default.Agent({ keepAlive: true });
const httpsAgent = new https_1.default.Agent({
    keepAlive: true,
    rejectUnauthorized: false
});
app.use(express_1.default.static(path_1.default.join(__dirname, "..", "public")));
function setCommonHeaders(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("cross-origin-opener-policy", "unsafe-none");
    res.setHeader("cross-origin-embedder-policy", "unsafe-none");
    res.setHeader("cross-origin-resource-policy", "cross-origin");
}
function sanitizeRequestHeaders(req, target) {
    const out = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value == null)
            continue;
        const lower = name.toLowerCase();
        if ([
            "host",
            "connection",
            "content-length",
            "accept-encoding",
            "upgrade"
        ].includes(lower))
            continue;
        out[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    out["accept-encoding"] = "identity";
    out["host"] = target.host;
    out["origin"] = target.origin;
    if (!out["user-agent"]) {
        out["user-agent"] =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132 Safari/537.36";
    }
    return out;
}
function stripDangerousResponseHeaders(upHeaders, res) {
    for (const [name, value] of Object.entries(upHeaders)) {
        if (value == null)
            continue;
        const lower = name.toLowerCase();
        if ([
            "content-security-policy",
            "content-security-policy-report-only",
            "x-frame-options",
            "x-content-type-options",
            "strict-transport-security",
            "content-length",
            "content-encoding",
            "transfer-encoding",
            "connection"
        ].includes(lower))
            continue;
        res.setHeader(name, value);
    }
}
app.all("/proxy", async (req, res) => {
    const raw = String(req.query.url || "");
    if (!raw)
        return res.status(400).send("Missing ?url=");
    let target;
    try {
        target = new url_1.URL(raw);
    }
    catch {
        return res.status(400).send("Invalid URL");
    }
    const headers = sanitizeRequestHeaders(req, target);
    const config = {
        url: target.href,
        method: req.method,
        headers,
        responseType: "arraybuffer",
        validateStatus: () => true,
        httpAgent,
        httpsAgent
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
        config.data = req.body;
    }
    try {
        const upstream = await (0, axios_1.default)(config);
        const status = upstream.status;
        const ct = String(upstream.headers["content-type"] || "");
        stripDangerousResponseHeaders(upstream.headers, res);
        setCommonHeaders(res);
        const buf = upstream.data;
        const isHtml = ct.includes("text/html");
        const isJs = ct.includes("javascript");
        const isCss = ct.includes("text/css");
        if (isHtml || isJs || isCss) {
            let text = buf.toString("utf8");
            if (isHtml)
                text = (0, rewriters_1.rewriteHtml)(text, target);
            if (isJs)
                text = (0, rewriters_1.rewriteJs)(text, target);
            if (isCss)
                text = (0, rewriters_1.rewriteCss)(text, target);
            const safeCt = ct.replace(/;\s*charset=[^;]+/i, "") + "; charset=utf-8";
            res.status(status).setHeader("content-type", safeCt);
            return res.send(text);
        }
        res.status(status).send(buf);
    }
    catch (err) {
        console.error("Proxy error:", err?.message || err);
        res.status(502).send("Upstream error");
    }
});
// ===============
// REAL WS TUNNEL
// ===============
const server = http_1.default.createServer(app);
/**
 * WARNING:
 * This is the ONLY correct approach.
 * You MUST pipe raw TCP → raw TCP.
 */
server.on("upgrade", (req, socket, head) => {
    try {
        const url = new url_1.URL("http://host" + req.url);
        if (url.pathname !== "/proxy_ws")
            return socket.destroy();
        const target = url.searchParams.get("url");
        if (!target)
            return socket.destroy();
        const upstream = new ws_1.default(target, {
            rejectUnauthorized: false,
            headers: {
                "User-Agent": req.headers["user-agent"] || "Mozilla",
                "Origin": new url_1.URL(target).origin
            }
        });
        upstream.on("open", () => {
            // Accept the WebSocket handshake manually
            socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "\r\n");
            // RAW piping: THIS is what Discord requires.
            socket.pipe(upstream._socket).pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        upstream.on("close", () => socket.end());
        socket.on("error", () => upstream.terminate());
    }
    catch (err) {
        socket.destroy();
    }
});
server.listen(PORT, () => console.log("Proxy running on http://localhost:" + PORT));
