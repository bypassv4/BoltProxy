import { URL } from "url";

const enum Encodings {
  Base64Url = "base64url"
}

// Must match PROXY_COOKIE_PREFIX in public/runtime.js
const PROXY_COOKIE_PREFIX = "__bpck__";

type ParsedSetCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  sameSite?: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
};

type ProxiedCookieMeta = {
  name: string;
  domain: string;
  path: string;
  hostOnly: boolean;
};

function normalizeDomain(input: string | undefined) {
  if (!input) return undefined;
  return input.replace(/^\./, "").trim().toLowerCase();
}

function parseSetCookie(raw: string): ParsedSetCookie | null {
  if (!raw) return null;
  const parts = raw.split(";").map((part) => part.trim());
  if (!parts.length) return null;

  const [nameValue, ...attrs] = parts;
  const eqIndex = nameValue.indexOf("=");
  if (eqIndex === -1) return null;

  const name = nameValue.slice(0, eqIndex).trim();
  const value = nameValue.slice(eqIndex + 1);

  const parsed: ParsedSetCookie = {
    name,
    value,
    path: undefined,
    domain: undefined,
    expires: undefined,
    maxAge: undefined,
    sameSite: undefined,
    secure: false,
    httpOnly: false,
    hostOnly: true
  };

  for (const attr of attrs) {
    if (!attr) continue;
    const [attrNameRaw, ...rest] = attr.split("=");
    const attrName = attrNameRaw.trim().toLowerCase();
    const attrValue = rest.join("=");

    switch (attrName) {
      case "path":
        parsed.path = attrValue || "/";
        break;
      case "domain":
        parsed.domain = normalizeDomain(attrValue);
        parsed.hostOnly = false;
        break;
      case "expires":
        parsed.expires = attrValue;
        break;
      case "max-age":
        parsed.maxAge = Number(attrValue);
        break;
      case "samesite":
        parsed.sameSite = attrValue;
        break;
      case "secure":
        parsed.secure = true;
        break;
      case "httponly":
        parsed.httpOnly = true;
        break;
      default:
        break;
    }
  }

  return parsed;
}

function encodeMeta(meta: ProxiedCookieMeta) {
  const json = JSON.stringify(meta);
  return Buffer.from(json, "utf8").toString(Encodings.Base64Url);
}

function decodeMeta(raw: string): ProxiedCookieMeta | null {
  try {
    const json = Buffer.from(raw, Encodings.Base64Url).toString("utf8");
    const meta = JSON.parse(json);
    if (
      !meta ||
      typeof meta.name !== "string" ||
      typeof meta.domain !== "string" ||
      typeof meta.path !== "string"
    ) {
      return null;
    }
    return {
      name: meta.name,
      domain: meta.domain,
      path: meta.path,
      hostOnly: Boolean(meta.hostOnly)
    };
  } catch {
    return null;
  }
}

function encodeValue(value: string) {
  return Buffer.from(value, "utf8").toString(Encodings.Base64Url);
}

function decodeValue(value: string) {
  return Buffer.from(value, Encodings.Base64Url).toString("utf8");
}

function domainMatches(targetHost: string, cookieDomain: string, hostOnly: boolean) {
  const host = targetHost.toLowerCase();
  const domain = cookieDomain.toLowerCase();
  if (hostOnly) return host === domain;
  return host === domain || host.endsWith("." + domain);
}

function pathMatches(targetPath: string, cookiePath: string) {
  const normalizedCookiePath = cookiePath || "/";
  const normalizedTargetPath = targetPath.startsWith("/")
    ? targetPath
    : "/" + targetPath;

  if (!normalizedTargetPath.startsWith(normalizedCookiePath)) return false;
  if (normalizedCookiePath.endsWith("/")) return true;
  if (normalizedTargetPath.length === normalizedCookiePath.length) return true;
  return normalizedTargetPath[normalizedCookiePath.length] === "/";
}

function parseBrowserCookies(header: string | undefined) {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter((entry): entry is { name: string; value: string } => Boolean(entry));
}

function normalizeTarget(target: URL) {
  return {
    host: target.hostname.toLowerCase(),
    path: target.pathname || "/"
  };
}

export function rewriteSetCookieHeaders(
  raw: string | string[] | undefined,
  target: URL,
  options: { secureProxy: boolean }
) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const proxied: string[] = [];
  const normalizedTarget = normalizeTarget(target);

  for (const entry of arr) {
    const parsed = parseSetCookie(entry);
    if (!parsed) continue;

    const cookieDomain = parsed.domain || normalizedTarget.host;
    const cookiePath = parsed.path || "/";

    const meta: ProxiedCookieMeta = {
      name: parsed.name,
      domain: cookieDomain,
      path: cookiePath,
      hostOnly: parsed.hostOnly
    };

    const encodedName = `${PROXY_COOKIE_PREFIX}${encodeMeta(meta)}`;
    const encodedValue = encodeValue(parsed.value);

    const segments = [`${encodedName}=${encodedValue}`, "Path=/"];

    if (parsed.expires) segments.push(`Expires=${parsed.expires}`);
    if (parsed.maxAge != null && !Number.isNaN(parsed.maxAge)) {
      segments.push(`Max-Age=${parsed.maxAge}`);
    }

    let sameSite = parsed.sameSite;

    if (!options.secureProxy) {
      // Browsers drop SameSite=None cookies without Secure on http origins.
      if (sameSite && sameSite.toLowerCase() === "none") {
        sameSite = undefined;
      }
    } else if (parsed.secure) {
      segments.push("Secure");
    }

    if (sameSite) {
      segments.push(`SameSite=${sameSite}`);
    }
    if (parsed.httpOnly) {
      segments.push("HttpOnly");
    }

    proxied.push(segments.join("; "));
  }

  return proxied;
}

export function buildUpstreamCookieHeader(
  browserCookieHeader: string | undefined,
  target: URL
) {
  const parsed = parseBrowserCookies(browserCookieHeader);
  if (!parsed.length) return undefined;

  const { host, path } = normalizeTarget(target);
  const pairs: string[] = [];

  for (const entry of parsed) {
    if (!entry.name.startsWith(PROXY_COOKIE_PREFIX)) continue;
    const encodedMeta = entry.name.slice(PROXY_COOKIE_PREFIX.length);
    const meta = decodeMeta(encodedMeta);
    if (!meta) continue;
    if (!domainMatches(host, meta.domain, meta.hostOnly)) continue;
    if (!pathMatches(path, meta.path)) continue;

    try {
      const actualValue = decodeValue(entry.value);
      pairs.push(`${meta.name}=${actualValue}`);
    } catch {
      continue;
    }
  }

  if (!pairs.length) return undefined;
  return pairs.join("; ");
}

export function getCookiePrefix() {
  return PROXY_COOKIE_PREFIX;
}
