import type { QualityResult } from "../domain/media.js";
interface CacheEntry<T> {
  revision: number;
  status: "loading" | "ready" | "error";
  promise?: Promise<T>;
  result?: T;
  error?: string;
}
export function createQualityCache<T extends QualityResult>(
  load: (id: string) => Promise<T>,
  { timeoutMs = 12000, onChange = () => {} } = {},
) {
  const entries = new Map<string, CacheEntry<T>>();
  const get = (id: string, revision: number) => {
    const item = entries.get(id);
    return item?.revision === revision ? item : undefined;
  };
  function resolve(id: string, revision: number, force = false) {
    const previous = get(id, revision);
    if (previous && !force) return previous.promise;
    const item: CacheEntry<T> = { revision, status: "loading" };
    entries.set(id, item);
    let timer;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Не удалось получить качества за 12 секунд. Нажмите ↻ для повторной попытки.",
            ),
          ),
        timeoutMs,
      );
    });
    item.promise = Promise.race([
      Promise.resolve().then(() => load(id)),
      timeout,
    ])
      .then((result) => {
        if (!result?.variants?.length)
          throw new Error("В источнике не найдены доступные качества.");
        if (entries.get(id) === item) {
          item.status = "ready";
          item.result = result;
        }
        return result;
      })
      .catch((error) => {
        if (entries.get(id) === item) {
          item.status = "error";
          item.error = error.message;
        }
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        if (entries.get(id) === item) onChange();
      });
    return item.promise;
  }
  return { get, resolve };
}
