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

  const ABSOLUTE_PROTOCOL_REGEX = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
  const NON_PROXY_SCHEMES = /^(?:data|javascript|mailto|tel|blob):/i;
  const PROXY_PREFIX = "/proxy?url=";
  const PROXY_WS_PREFIX = "/proxy_ws?url=";

  const PROXIED_NODE_SELECTOR =
    "img,script,link,iframe,video,audio,source,track,form,a";
  const MONITORED_ATTRS = new Set(["src", "href", "action", "poster"]);

  const originalSetAttribute = Element.prototype.setAttribute;

  function resolveBaseOrigin() {
    return window.__proxy_target || window.location.origin;
  }

  function absolutizeHttpUrl(raw) {
    if (raw == null) return raw;
    if (raw instanceof URL) return raw.href;

    const value = String(raw).trim();
    if (!value || NON_PROXY_SCHEMES.test(value)) return value;
    if (ABSOLUTE_PROTOCOL_REGEX.test(value)) return value;

    if (value.startsWith("//")) {
      try {
        const base = new URL(resolveBaseOrigin());
        return base.protocol + value;
      } catch {
        return window.location.protocol + value;
      }
    }

    try {
      return new URL(value, resolveBaseOrigin()).href;
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
      const httpUrl = new URL(value, resolveBaseOrigin());
      httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
      return httpUrl.href;
    } catch {
      return value;
    }
  }

  function wrapHttp(url) {
    if (typeof url === "string" && url.startsWith(PROXY_PREFIX)) return url;
    const absolute = absolutizeHttpUrl(url);
    return PROXY_PREFIX + encodeURIComponent(String(absolute ?? ""));
  }

  function wrapWs(url) {
    if (typeof url === "string" && url.startsWith(PROXY_WS_PREFIX)) return url;
    const absolute = absolutizeWsUrl(url);
    return PROXY_WS_PREFIX + encodeURIComponent(String(absolute ?? ""));
  }

  function shouldProxy(value) {
    if (!value) return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return !NON_PROXY_SCHEMES.test(trimmed);
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

  function rewriteElementAttribute(el, attr) {
    if (!el.hasAttribute(attr)) return;
    const value = el.getAttribute(attr);
    if (!shouldProxy(value)) return;
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
      value = wrapHttp(value);
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
          value = wrapper(value);
        } else if (value instanceof URL) {
          value = wrapper(value);
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

  patchUrlProperty(HTMLScriptElement, "src", wrapHttp);
  patchUrlProperty(HTMLLinkElement, "href", wrapHttp);
  patchUrlProperty(HTMLImageElement, "src", wrapHttp);
  patchUrlProperty(HTMLIFrameElement, "src", wrapHttp);
  patchUrlProperty(HTMLVideoElement, "src", wrapHttp);
  patchUrlProperty(HTMLAudioElement, "src", wrapHttp);
  patchUrlProperty(HTMLSourceElement, "src", wrapHttp);
  patchUrlProperty(HTMLTrackElement, "src", wrapHttp);
  patchUrlProperty(HTMLAnchorElement, "href", wrapHttp);
  patchUrlProperty(HTMLFormElement, "action", wrapHttp);
  patchUrlProperty(HTMLObjectElement, "data", wrapHttp);
  patchSrcSetProperty(HTMLImageElement, "srcset");
  patchSrcSetProperty(HTMLSourceElement, "srcset");

  window.__proxy_fetch = function (input, init = {}) {
    if (input instanceof Request) {
      const proxied = wrapHttp(input.url);
      const derivedInit = {
        method: input.method,
        headers: new Headers(input.headers),
        body:
          input.method === "GET" || input.method === "HEAD"
            ? undefined
            : input.body,
      };
      const nextInit = { ...derivedInit, ...init };
      return nativeFetch(proxied, nextInit);
    }

    const target = input instanceof URL ? input.href : input;
    return nativeFetch(wrapHttp(target), init);
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
          url = wrapHttp(url);
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
        url = wrapHttp(url);
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

  // *** CHANGED: serviceWorker shim no longer returns a fake registration ***
  try {
    if (
      navigator.serviceWorker &&
      typeof navigator.serviceWorker.register === "function"
    ) {
      const origRegister = navigator.serviceWorker.register.bind(
        navigator.serviceWorker
      );
      navigator.serviceWorker.register = function (scriptURL, options) {
        try {
          scriptURL = wrapHttp(scriptURL);
        } catch (err) {
          console.warn(
            "[runtime] failed to rewrite serviceWorker script URL",
            err
          );
        }
        // Do NOT swallow failures – let the promise reject normally.
        return origRegister(scriptURL, options);
      };
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
    const descriptor = Object.getOwnPropertyDescriptor(Location.prototype, "href");
    if (descriptor && descriptor.set) {
      Object.defineProperty(Location.prototype, "href", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          return window.__proxy_target || descriptor.get.call(this);
        },
        set(value) {
          descriptor.set.call(this, wrapHttp(value));
        },
      });
    }
  } catch (err) {
    console.warn("[runtime] failed to patch Location.href", err);
  }

  if (window.__proxy_target) {
    try {
      const targetUrl = new URL(window.__proxy_target);
      const props = ['protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];
      props.forEach(prop => {
        Object.defineProperty(window.location, prop, {
          get: () => targetUrl[prop],
          configurable: true
        });
      });
    } catch (err) {
      console.warn("[runtime] failed to spoof location properties", err);
    }
  }

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
