import { isVendorUrl } from "../core/media.js";
export async function loadManifest(
  url: string,
  inline?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (inline) return inline;
  if (isVendorUrl(url))
    throw new Error("Этот служебный адрес не является источником видео.");
  const response = await fetch(url, {
    credentials: "include",
    signal: AbortSignal.any(
      [AbortSignal.timeout(20000), signal].filter(Boolean),
    ),
  });
  if (!response.ok)
    throw new Error(
      `Манифест: HTTP ${response.status}. Обновите страницу и включите видео.`,
    );
  if (Number(response.headers.get("content-length")) > 4000000)
    throw new Error("Слишком большой манифест.");
  const reader = response.body.getReader();
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4000000) throw new Error("Слишком большой манифест.");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
