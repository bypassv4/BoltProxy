(() => {
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const nativeSendBeacon =
    typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon.bind(navigator)
      : null;
  const NativeEventSource = window.EventSource;
  const nativeLocationAssign = window.location.assign.bind(window.location);
  const nativeLocationReplace = window.location.replace.bind(window.location);
  const nativeWindowOpen =
    typeof window.open === "function" ? window.open.bind(window) : null;
  const nativeLocationHrefDescriptor = Object.getOwnPropertyDescriptor(
    Location.prototype,
    "href"
  );
  const nativeLocationHrefGetter =
    nativeLocationHrefDescriptor && typeof nativeLocationHrefDescriptor.get === "function"
      ? nativeLocationHrefDescriptor.get.bind(window.location)
      : null;

  const ABSOLUTE_PROTOCOL_REGEX = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
  const NON_PROXY_SCHEMES = /^(?:data|javascript|mailto|tel|blob):/i;
  const PROXY_PREFIX = "/proxy?url=";
  const PROXY_POST_PREFIX = "/post?url=";
  const PROXY_WS_PREFIX = "/proxy_ws?url=";
  const PROXY_COOKIE_PREFIX = "__bpck__";

  const PROXIED_NODE_SELECTOR =
    "img,script,link,iframe,video,audio,source,track,form,a";
  const MONITORED_ATTRS = new Set(["src", "href", "action", "poster"]);

  const originalSetAttribute = Element.prototype.setAttribute;

  function isAlreadyProxied(url) {
    if (!url) return false;
    if (typeof url === "string") {
      if (
        url.startsWith(PROXY_PREFIX) ||
        url.startsWith(PROXY_POST_PREFIX) ||
        url.startsWith(PROXY_WS_PREFIX)
      )
        return true;
    }
    try {
      const abs = new URL(String(url), resolveBaseUrl());
      return abs.pathname === "/proxy" || abs.pathname === "/proxy_ws" || abs.pathname === "/post";
    } catch {
      return false;
    }
  }

  // Pretend the page is secure so secure/samesite cookies and captcha flows work.
  try {
    Object.defineProperty(window, "isSecureContext", { value: true });
  } catch {
    // ignore
  }

  function resolveBaseUrl() {
    try {
      return window.__proxy_target || readNativeLocationHref();
    } catch {
      return readNativeLocationHref();
    }
  }

  function rewriteHistoryUrl(value) {
    if (value == null) return null;
    if (value instanceof URL) {
      setTargetUrl(value);
      return wrapHttp(value);
    }

    const str = String(value).trim();
    if (!shouldProxy(str)) return null;
    const absolute = absolutizeHttpUrl(str);
    if (!absolute) return null;
    setTargetUrl(absolute);
    return wrapHttp(absolute);
  }

  function patchHistoryMethod(method) {
    const native = history[method];
    if (typeof native !== "function") return;

    history[method] = function (...args) {
      if (args.length > 2 && args[2] != null) {
        try {
          const rewritten = rewriteHistoryUrl(args[2]);
          if (rewritten) {
            args[2] = rewritten;
          }
        } catch (err) {
          console.warn(`[runtime] failed to rewrite history.${method}`, err);
        }
      }
      return native.apply(this, args);
    };
  }

  function readNativeLocationHref() {
    if (nativeLocationHrefGetter) {
      try {
        return nativeLocationHrefGetter();
      } catch {
        // ignore
      }
    }
    return window.location.href;
  }

  function absolutizeHttpUrl(raw) {
    if (raw == null) return raw;
    if (raw instanceof URL) return raw.href;

    const value = String(raw).trim();
    if (!value || NON_PROXY_SCHEMES.test(value)) return value;
    if (ABSOLUTE_PROTOCOL_REGEX.test(value)) return value;

    if (value.startsWith("//")) {
      try {
        const base = new URL(resolveBaseUrl());
        return base.protocol + value;
      } catch {
        return window.location.protocol + value;
      }
    }

    try {
      return new URL(value, resolveBaseUrl()).href;
    } catch {
      return value;
    }
  }

  function absolutizeWsUrl(raw) {
    if (raw == null) return raw;
    if (raw instanceof URL) return raw.href.replace(/^http/, "ws");

    const value = String(raw).trim();
    if (/^ws(s)?:\/\//i.test(value)) return value;

    try {
      const httpUrl = new URL(value, resolveBaseUrl());
      httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
      return httpUrl.href;
    } catch {
      return value;
    }
  }

  function wrapHttp(url, method = "GET") {
    const methodUpper = typeof method === "string" ? method.toUpperCase() : "GET";
    const preferPost = methodUpper === "POST";

    if (preferPost && typeof url === "string" && url.startsWith(PROXY_PREFIX)) {
      return PROXY_POST_PREFIX + url.slice(PROXY_PREFIX.length);
    }
    if (preferPost) {
      try {
        const parsed = new URL(String(url), resolveBaseUrl());
        if (parsed.pathname === "/proxy" && parsed.searchParams.has("url")) {
          return PROXY_POST_PREFIX + parsed.searchParams.get("url");
        }
      } catch {
        // ignore
      }
    }

    if (isAlreadyProxied(url)) return String(url);

    const absolute = absolutizeHttpUrl(url);
    if (isAlreadyProxied(absolute)) return String(absolute ?? "");

    const prefix = preferPost ? PROXY_POST_PREFIX : PROXY_PREFIX;
    return prefix + encodeURIComponent(String(absolute ?? ""));
  }

  function wrapWs(url) {
    if (isAlreadyProxied(url)) return String(url);
    const absolute = absolutizeWsUrl(url);
    if (isAlreadyProxied(absolute)) return String(absolute ?? "");
    return PROXY_WS_PREFIX + encodeURIComponent(String(absolute ?? ""));
  }

  function shouldProxy(value) {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return !NON_PROXY_SCHEMES.test(trimmed);
  }

  function base64UrlEncode(str) {
    const base64 = btoa(unescape(encodeURIComponent(str)));
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlDecode(str) {
    let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) {
      base64 += "=";
    }
    return decodeURIComponent(escape(atob(base64)));
  }

  function parseCookiePairs(header) {
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
      .filter(Boolean);
  }

  function getTargetUrl() {
    const base = window.__proxy_target || readNativeLocationHref();
    try {
      return new URL(base);
    } catch {
      return new URL(readNativeLocationHref());
    }
  }

  function setTargetUrl(value) {
    try {
      const next =
        value instanceof URL ? value : new URL(String(value), getTargetUrl());
      window.__proxy_target = next.href;
      return next;
    } catch {
      return null;
    }
  }

  function decodeCookieMeta(raw) {
    try {
      const json = base64UrlDecode(raw);
      const parsed = JSON.parse(json);
      if (
        !parsed ||
        typeof parsed.name !== "string" ||
        typeof parsed.domain !== "string" ||
        typeof parsed.path !== "string"
      ) {
        return null;
      }
      return {
        name: parsed.name,
        domain: parsed.domain,
        path: parsed.path,
        hostOnly: Boolean(parsed.hostOnly)
      };
    } catch {
      return null;
    }
  }

  function domainMatches(targetHost, cookieDomain, hostOnly) {
    const host = targetHost.toLowerCase();
    const domain = cookieDomain.toLowerCase();
    if (hostOnly) return host === domain;
    return host === domain || host.endsWith("." + domain);
  }

  function pathMatches(targetPath, cookiePath) {
    const normalizedCookiePath = cookiePath || "/";
    const normalizedTargetPath = targetPath.startsWith("/")
      ? targetPath
      : "/" + targetPath;
    if (!normalizedTargetPath.startsWith(normalizedCookiePath)) return false;
    if (normalizedCookiePath.endsWith("/")) return true;
    if (normalizedTargetPath.length === normalizedCookiePath.length) return true;
    return normalizedTargetPath[normalizedCookiePath.length] === "/";
  }

  function formatDocumentCookie(raw) {
    const target = getTargetUrl();
    const host = target.hostname.toLowerCase();
    const path = target.pathname || "/";
    const pairs = parseCookiePairs(raw);
    const out = [];
    for (const entry of pairs) {
      if (!entry || !entry.name.startsWith(PROXY_COOKIE_PREFIX)) continue;
      const meta = decodeCookieMeta(
        entry.name.slice(PROXY_COOKIE_PREFIX.length)
      );
      if (!meta) continue;
      if (!domainMatches(host, meta.domain, meta.hostOnly)) continue;
      if (!pathMatches(path, meta.path)) continue;
      try {
        const actualValue = base64UrlDecode(entry.value);
        out.push(`${meta.name}=${actualValue}`);
      } catch {
        continue;
      }
    }
    return out.join("; ");
  }

  function parseCookieAssignment(raw) {
    if (!raw) return null;
    const segments = raw.split(";").map((part) => part.trim()).filter(Boolean);
    if (!segments.length) return null;
    const [nameValue, ...attrs] = segments;
    const eq = nameValue.indexOf("=");
    if (eq === -1) return null;
    const name = nameValue.slice(0, eq).trim();
    const value = nameValue.slice(eq + 1);
    const parsed = {
      name,
      value,
      path: "/",
      domain: null,
      expires: undefined,
      maxAge: undefined,
      sameSite: undefined,
      secure: false
    };

    for (const attr of attrs) {
      const [attrNameRaw, ...rest] = attr.split("=");
      const attrName = attrNameRaw.trim().toLowerCase();
      const attrValue = rest.join("=");
      switch (attrName) {
        case "path":
          parsed.path = attrValue || "/";
          break;
        case "domain":
          parsed.domain = attrValue ? attrValue.replace(/^\./, "") : null;
          break;
        case "expires":
          parsed.expires = attrValue;
          break;
        case "max-age":
          parsed.maxAge = attrValue;
          break;
        case "samesite":
          parsed.sameSite = attrValue;
          break;
        case "secure":
          parsed.secure = true;
          break;
        default:
          break;
      }
    }

    return parsed;
  }

  function rewriteDocumentCookie(value) {
    const parsed = parseCookieAssignment(value);
    if (!parsed) return value;
    const target = getTargetUrl();
    const domain =
      parsed.domain?.trim().toLowerCase() || target.hostname.toLowerCase();
    const hostOnly = !parsed.domain;
    const meta = {
      name: parsed.name,
      domain,
      path: parsed.path || "/",
      hostOnly
    };

    const encodedName = `${PROXY_COOKIE_PREFIX}${base64UrlEncode(
      JSON.stringify(meta)
    )}`;
    const encodedValue = base64UrlEncode(parsed.value);
    const segments = [`${encodedName}=${encodedValue}`, "Path=/"];
    if (parsed.expires) segments.push(`Expires=${parsed.expires}`);
    if (parsed.maxAge != null) segments.push(`Max-Age=${parsed.maxAge}`);

    if (parsed.sameSite) {
      const lower = parsed.sameSite.toLowerCase();
      if (!(lower === "none" && !window.isSecureContext)) {
        segments.push(`SameSite=${parsed.sameSite}`);
      }
    }
    if (parsed.secure && window.isSecureContext) {
      segments.push("Secure");
    }

    return segments.join("; ");
  }

  function rewriteSrcSet(value) {
    if (!value) return value;
    return value
      .split(",")
      .map((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return trimmed;
        const [url, descriptor] = trimmed.split(/\s+/, 2);
        if (!shouldProxy(url)) return entry;
        try {
          const proxied = wrapHttp(url);
          return descriptor ? `${proxied} ${descriptor}` : proxied;
        } catch {
          return entry;
        }
      })
      .join(", ");
  }

  function getFormMethod(el) {
    try {
      const attrMethod =
        typeof el.getAttribute === "function" ? el.getAttribute("method") : null;
      const propMethod = el && "method" in el ? el.method : null;
      const raw = (attrMethod || propMethod || "").toString().trim();
      return raw ? raw.toUpperCase() : null;
    } catch {
      return null;
    }
  }

  function wrapAction(value, el) {
    const method = getFormMethod(el) || "GET";
    return wrapHttp(value, method);
  }

  function rewriteElementAttribute(el, attr) {
    if (!el.hasAttribute(attr)) return;
    const value = el.getAttribute(attr);
    if (!shouldProxy(value)) return;
    if (el.tagName === "FORM" && attr.toLowerCase() === "action") {
      return originalSetAttribute.call(el, attr, wrapAction(value, el));
    }
    originalSetAttribute.call(el, attr, wrapHttp(value));
  }

  function rewriteSrcSetAttribute(el) {
    if (!el.hasAttribute("srcset")) return;
    const rewritten = rewriteSrcSet(el.getAttribute("srcset"));
    if (rewritten != null) {
      originalSetAttribute.call(el, "srcset", rewritten);
    }
  }

  function proxifyElement(el) {
    const tag = el.tagName;
    if (tag === "SOURCE" || tag === "IMG") {
      rewriteSrcSetAttribute(el);
    }
    if (tag === "FORM") {
      rewriteElementAttribute(el, "action");
    }
    if (tag === "A") {
      rewriteElementAttribute(el, "href");
    }
    if (
      tag === "SCRIPT" ||
      tag === "IFRAME" ||
      tag === "IMG" ||
      tag === "VIDEO" ||
      tag === "AUDIO" ||
      tag === "SOURCE" ||
      tag === "TRACK" ||
      tag === "LINK"
    ) {
      rewriteElementAttribute(el, "src");
      rewriteElementAttribute(el, "href");
      rewriteElementAttribute(el, "poster");
    }
  }

  function proxifyNodeTree(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    proxifyElement(element);
    element.querySelectorAll(PROXIED_NODE_SELECTOR).forEach(proxifyElement);
  }

  Element.prototype.setAttribute = function (name, value) {
    const lower = name.toLowerCase();
    if (lower === "srcset") {
      const rewritten = rewriteSrcSet(value);
      if (rewritten != null) {
        return originalSetAttribute.call(this, name, rewritten);
      }
    }
    if (MONITORED_ATTRS.has(lower) && shouldProxy(value)) {
      const isFormAction = lower === "action" && this.tagName === "FORM";
      value = isFormAction ? wrapAction(value, this) : wrapHttp(value);
    }
    return originalSetAttribute.call(this, name, value);
  };

  function patchUrlProperty(Ctor, property, wrapper) {
    if (!Ctor || !Ctor.prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, property);
    if (!descriptor || typeof descriptor.set !== "function") return;

    Object.defineProperty(Ctor.prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (typeof value === "string" && shouldProxy(value)) {
          value = wrapper(value, this);
        } else if (value instanceof URL) {
          value = wrapper(value, this);
        }
        return descriptor.set.call(this, value);
      },
    });
  }

  function patchSrcSetProperty(Ctor, property) {
    if (!Ctor || !Ctor.prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(Ctor.prototype, property);
    if (!descriptor || typeof descriptor.set !== "function") return;

    Object.defineProperty(Ctor.prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        return descriptor.set.call(this, rewriteSrcSet(String(value)));
      },
    });
  }

  function patchDocumentCookie() {
    if (typeof Document === "undefined") return;
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (!descriptor) return;

    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        if (typeof descriptor.get !== "function") return "";
        if (!window.__proxy_target) {
          return descriptor.get.call(this);
        }
        try {
          const raw = descriptor.get.call(this);
          return formatDocumentCookie(raw);
        } catch (err) {
          console.warn("[runtime] failed to read document.cookie", err);
          return descriptor.get.call(this);
        }
      },
      set(value) {
        if (typeof descriptor.set !== "function") return value;
        if (!window.__proxy_target) {
          return descriptor.set.call(this, value);
        }
        try {
          const rewritten = rewriteDocumentCookie(value);
          return descriptor.set.call(this, rewritten);
        } catch (err) {
          console.warn("[runtime] failed to rewrite document.cookie", err);
          return descriptor.set.call(this, value);
        }
      },
    });
  }

  patchDocumentCookie();
  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");

  patchUrlProperty(HTMLScriptElement, "src", wrapHttp);
  patchUrlProperty(HTMLLinkElement, "href", wrapHttp);
  patchUrlProperty(HTMLImageElement, "src", wrapHttp);
  patchUrlProperty(HTMLIFrameElement, "src", wrapHttp);
  patchUrlProperty(HTMLVideoElement, "src", wrapHttp);
  patchUrlProperty(HTMLAudioElement, "src", wrapHttp);
  patchUrlProperty(HTMLSourceElement, "src", wrapHttp);
  patchUrlProperty(HTMLTrackElement, "src", wrapHttp);
  patchUrlProperty(HTMLAnchorElement, "href", wrapHttp);
  patchUrlProperty(HTMLFormElement, "action", wrapAction);
  patchUrlProperty(HTMLObjectElement, "data", wrapHttp);
  patchSrcSetProperty(HTMLImageElement, "srcset");
  patchSrcSetProperty(HTMLSourceElement, "srcset");

  window.__proxy_fetch = function (input, init = {}) {
    if (input instanceof Request) {
      const initMethod = init && init.method ? String(init.method) : null;
      const method = (initMethod || input.method || "GET").toUpperCase();
      const proxiedUrl = wrapHttp(input.url, method);
      // Preserve all request options (credentials, mode, redirect, integrity, etc.)
      // by cloning the original Request when swapping the URL.
      const cloned = new Request(proxiedUrl, input);
      const finalRequest =
        init && Object.keys(init).length ? new Request(cloned, init) : cloned;
      return nativeFetch(finalRequest);
    }

    const target = input instanceof URL ? input.href : input;
    const method = init && init.method ? String(init.method) : "GET";
    return nativeFetch(wrapHttp(target, method), init);
  };

  window.fetch = function (...args) {
    return window.__proxy_fetch(...args);
  };

  class ProxyWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(wrapWs(url), protocols);
    }
  }
  window.WebSocket = ProxyWebSocket;

  if (NativeXMLHttpRequest) {
    const originalOpen = NativeXMLHttpRequest.prototype.open;
    NativeXMLHttpRequest.prototype.open = function (
      method,
      url,
      async = true,
      username,
      password
    ) {
      if (url) {
        try {
          url = wrapHttp(url, method);
        } catch (err) {
          console.warn("[runtime] failed to rewrite XHR", err);
        }
      }
      return originalOpen.call(
        this,
        method,
        url,
        async,
        username ?? null,
        password ?? null
      );
    };
  }

  if (nativeSendBeacon) {
    navigator.sendBeacon = function (url, data) {
      try {
        url = wrapHttp(url, "POST");
      } catch (err) {
        console.warn("[runtime] failed to rewrite sendBeacon", err);
      }
      return nativeSendBeacon(url, data ?? null);
    };
  }

  if (NativeEventSource) {
    class ProxyEventSource extends NativeEventSource {
      constructor(url, eventSourceInitDict) {
        super(wrapHttp(url), eventSourceInitDict);
      }
    }
    ProxyEventSource.CONNECTING = NativeEventSource.CONNECTING;
    ProxyEventSource.OPEN = NativeEventSource.OPEN;
    ProxyEventSource.CLOSED = NativeEventSource.CLOSED;
    window.EventSource = ProxyEventSource;
  }

  // serviceWorker: rewrite URL and, if the environment blocks SW (http), return a benign fake registration
  try {
    if (
      navigator.serviceWorker &&
      typeof navigator.serviceWorker.register === "function"
    ) {
      const origRegister = navigator.serviceWorker.register.bind(
        navigator.serviceWorker
      );
      const createFakeRegistration = () => ({
        installing: null,
        waiting: null,
        active: null,
        scope: resolveBaseUrl(),
        update: async () => {},
        unregister: async () => true
      });

      navigator.serviceWorker.register = async function (scriptURL, options) {
        try {
          scriptURL = wrapHttp(scriptURL);
        } catch (err) {
          console.warn(
            "[runtime] failed to rewrite serviceWorker script URL",
            err
          );
        }
        try {
          return await origRegister(scriptURL, options);
        } catch (err) {
          // Insecure origins block SW; provide a harmless fake so callers continue.
          console.warn("[runtime] serviceWorker register blocked; returning fake", err);
          return createFakeRegistration();
        }
      };

      // Ensure navigator.serviceWorker.ready resolves to avoid hangs that expect it.
      if ("ready" in navigator.serviceWorker) {
        const readyPromise = Promise.resolve(createFakeRegistration());
        try {
          Object.defineProperty(navigator.serviceWorker, "ready", {
            get() {
              return readyPromise;
            }
          });
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    console.warn("[runtime] serviceWorker shim failed", err);
  }

  try {
    const NativeWorkerCtor = window.Worker;
    if (typeof NativeWorkerCtor === "function") {
      window.Worker = function (scriptURL, options) {
        try {
          scriptURL = wrapHttp(scriptURL);
        } catch (err) {
          console.warn("[runtime] failed to rewrite Worker script URL", err);
        }
        return new NativeWorkerCtor(scriptURL, options);
      };
    }
    if (typeof window.SharedWorker === "function") {
      const NativeShared = window.SharedWorker;
      window.SharedWorker = function (scriptURL, options) {
        try {
          scriptURL = wrapHttp(scriptURL);
        } catch (err) {
          console.warn(
            "[runtime] failed to rewrite SharedWorker script URL",
            err
          );
        }
        return new NativeShared(scriptURL, options);
      };
    }
  } catch (err) {
    console.warn("[runtime] worker shims failed", err);
  }

  window.location.assign = function (url) {
    nativeLocationAssign(wrapHttp(url));
  };
  window.location.replace = function (url) {
    nativeLocationReplace(wrapHttp(url));
  };

  try {
    const descriptor = nativeLocationHrefDescriptor;
    if (descriptor && descriptor.set && descriptor.get) {
      Object.defineProperty(Location.prototype, "href", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          try {
            return getTargetUrl().href;
          } catch {
            return descriptor.get.call(this);
          }
        },
        set(value) {
          descriptor.set.call(this, wrapHttp(value));
        },
      });
    }
  } catch (err) {
    console.warn("[runtime] failed to patch Location.href", err);
  }

  function patchLocationGetters() {
    const props = [
      "protocol",
      "host",
      "hostname",
      "port",
      "pathname",
      "search",
      "hash",
      "origin"
    ];

    props.forEach((prop) => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(Location.prototype, prop);
        if (!descriptor || typeof descriptor.get !== "function") return;
        Object.defineProperty(Location.prototype, prop, {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            try {
              const target = getTargetUrl();
              return target[prop];
            } catch {
              return descriptor.get.call(this);
            }
          },
        });
      } catch (err) {
        console.warn(`[runtime] failed to patch Location.${prop}`, err);
      }
    });
  }

  patchLocationGetters();

  if (nativeWindowOpen) {
    window.open = function (url, target, features) {
      if (url != null) {
        try {
          url = wrapHttp(url);
        } catch (err) {
          console.warn("[runtime] failed to rewrite window.open", err);
        }
      }
      return nativeWindowOpen(url, target, features);
    };
  }

  proxifyNodeTree(document.documentElement);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      Array.from(mutation.addedNodes).forEach((node) => {
        proxifyNodeTree(node);
      });
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.__proxy_import = function (url) {
    return import(/* webpackIgnore: true */ wrapHttp(url));
  };
})();
