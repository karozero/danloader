// Observe only the normal page player's successful SABR requests. No player API clients or token generation.
(() => {
  const yt = () => /(?:^|\.)youtube\.com$/.test(location.hostname);
  if (!yt()) return;
  const pageId = () =>
    new URL(location.href).searchParams.get("v") ||
    /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(location.pathname)?.[1];
  const cdn = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" &&
        u.hostname.endsWith(".googlevideo.com") &&
        u.pathname === "/videoplayback"
        ? u
        : null;
    } catch {
      return null;
    }
  };
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768)
      s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  };
  const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  let session;
  const fetchPage = window.fetch,
    controllers = new Map();
  async function save(url, body, response, videoId, options: RequestInit = {}) {
    if (
      !videoId ||
      pageId() !== videoId ||
      !cdn(url) ||
      !response.ok ||
      !/yt-ump/i.test(response.headers.get("content-type") || "")
    )
      return;
    let data =
      body instanceof Blob
        ? new Uint8Array(await body.arrayBuffer())
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
            : null;
    if (!data?.length || data.length > 262144) return;
    session = {
      videoId,
      url: String(url),
      body: b64(data),
      time: Date.now(),
      credentials: options.credentials || "same-origin",
      headers: new Headers(options.headers || {}),
    };
    window.postMessage({ channel: "dan-video-sabr-ready" }, location.origin);
  }
  window.fetch = function (input, options = {}) {
    const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input?.url,
      videoId = pageId();
    let body;
    if (
      cdn(url) &&
      String(
        options.method ||
          (input instanceof Request ? input.method : undefined) ||
          "GET",
      ).toUpperCase() === "POST"
    )
      try {
        body =
          options.body !== undefined
            ? Promise.resolve(options.body)
            : input instanceof Request
              ? input.clone().arrayBuffer()
              : Promise.resolve(null);
      } catch {}
    const result = Reflect.apply(fetchPage, this, arguments);
    if (body) {
      result
        .then(async (response) =>
          save(url, await body, response, videoId, {
            credentials:
              options.credentials ||
              (input instanceof Request ? input.credentials : undefined),
            headers:
              options.headers ||
              (input instanceof Request ? input.headers : undefined),
          }),
        )
        .catch(() => {});
    }
    return result;
  };
  const open = XMLHttpRequest.prototype.open,
    send = XMLHttpRequest.prototype.send,
    requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    requests.set(this, {
      method,
      url: String(url),
      videoId: pageId(),
      headers: {},
    });
    return Reflect.apply(open, this, arguments);
  };
  const setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const req = requests.get(this);
    if (req) req.headers[name] = value;
    return Reflect.apply(setHeader, this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const req = requests.get(this);
    if (req && cdn(req.url) && String(req.method).toUpperCase() === "POST")
      this.addEventListener("load", () =>
        save(
          req.url,
          body,
          {
            ok: this.status >= 200 && this.status < 300,
            headers: { get: () => this.getResponseHeader("Content-Type") },
          },
          req.videoId,
          {
            credentials: this.withCredentials ? "include" : "same-origin",
            headers: req.headers,
          },
        ).catch(() => {}),
      );
    return Reflect.apply(send, this, arguments);
  };
  const current = () =>
    session &&
    session.videoId === pageId() &&
    Date.now() - session.time < 600000
      ? session
      : null;
  Object.defineProperty(window, "DanVideoSession", {
    value: Object.freeze({ ready: () => Boolean(current()) }),
    configurable: false,
  });
  window.addEventListener("message", async (event) => {
    const m = event.data;
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      m?.channel !== "dan-video-youtube-media-request"
    )
      return;
    const reply = (value) =>
      window.postMessage(
        { channel: "dan-video-youtube-media-result", uid: m.uid, ...value },
        location.origin,
      );
    try {
      if (m.action === "cancel") {
        controllers.get(m.jobId)?.abort();
        reply({ ok: true, value: true });
        return;
      }
      const native = current();
      if (!native || m.videoId !== pageId())
        throw new Error(
          "Запустите обычное воспроизведение YouTube, затем повторите скачивание: нет действующей SABR-сессии.",
        );
      if (m.action === "session") {
        reply({ ok: true, value: { url: native.url, body: native.body } });
        return;
      }
      if (m.action !== "fetch") throw new Error("Неизвестная команда SABR.");
      const target = cdn(m.url),
        source = cdn(native.url);
      if (
        !target ||
        target.searchParams.get("id") !== source.searchParams.get("id")
      )
        throw new Error("Источник SABR не совпадает с открытым видео.");
      if (typeof m.body !== "string" || m.body.length > 350000)
        throw new Error("Недопустимый запрос SABR.");
      const controller = new AbortController();
      controllers.set(m.jobId, controller);
      try {
        const headers = new Headers(native.headers);
        headers.set("Content-Type", "application/x-protobuf");
        headers.set("Accept", "application/vnd.yt-ump");
        const r = await fetchPage(target.href, {
          method: "POST",
          body: bytes(m.body),
          headers,
          credentials: native.credentials,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30000),
          ]),
        });
        if (!r.ok)
          throw new Error(
            "YouTube SABR: HTTP " +
              r.status +
              ". Обновите обычное воспроизведение; проверка доступа не обходится.",
          );
        const reader = r.body.getReader(),
          parts = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16777216)
              throw new Error(
                "Пакет SABR превышает 16 МБ. Выберите меньшее качество.",
              );
            parts.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const output = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
          output.set(part, at);
          at += part.length;
        }
        reply({
          ok: true,
          value: {
            body: b64(output),
            mime: r.headers.get("content-type") || "",
          },
        });
      } finally {
        controllers.delete(m.jobId);
      }
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  });
})();
