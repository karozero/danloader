let offscreenCreation: Promise<void> | undefined;
async function ensureOffscreen() {
  if (
    (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))
      .length
  )
    return;
  if (!offscreenCreation)
    offscreenCreation = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS", "BLOBS"],
        justification: "Обработка видеопотоков и сохранение локального файла.",
      })
      .finally(() => {
        offscreenCreation = null;
      });
  await offscreenCreation;
}
export async function offscreen<T = unknown>(
  action: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  await ensureOffscreen();
  let timer;
  const result = await Promise.race([
    chrome.runtime.sendMessage({ target: "offscreen", action, ...data }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Подготовка загрузчика превысила 30 секунд. Повторите скачивание.",
            ),
          ),
        30000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (!result?.ok) throw new Error(result?.error || "Загрузчик не ответил.");
  return result.value as T;
}
