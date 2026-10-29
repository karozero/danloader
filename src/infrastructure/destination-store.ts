import type { Destination } from "../domain/media.js";
const databaseName = "dan-video-destinations";

async function withStore<T = void>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("settings", mode);
      let result: T;
      operation(
        transaction.objectStore("settings"),
        (value) => (result = value),
      );
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(
          transaction.error ||
            new Error("Не удалось сохранить настройку папки."),
        );
    });
  } finally {
    database.close();
  }
}
const read = <T>(key: string) =>
  withStore<T>("readonly", (store, result) => {
    const request = store.get(key);
    request.onsuccess = () => result(request.result);
  });

export async function selectDirectory(handle: FileSystemDirectoryHandle) {
  if (
    handle?.kind !== "directory" ||
    (await handle.queryPermission({ mode: "readwrite" })) !== "granted"
  )
    throw new Error("Разрешите запись в выбранную папку.");
  const destination = {
    mode: "directory" as const,
    id: crypto.randomUUID(),
    name: handle.name,
  };
  await withStore("readwrite", (store) => {
    store.put(handle, destination.id);
    store.put(destination, "active");
  });
  return { ...destination, permission: "granted" };
}
export async function useBrowserDirectory(): Promise<Destination> {
  await withStore("readwrite", (store) =>
    store.put({ mode: "browser" }, "active"),
  );
  return { mode: "browser" };
}
export async function currentDestination(): Promise<Destination> {
  const value = await read<Destination>("active");
  if (value?.mode !== "directory") return { mode: "browser" };
  const handle = await read<FileSystemDirectoryHandle>(value.id);
  const permission: PermissionState = handle
    ? await handle
        .queryPermission({ mode: "readwrite" })
        .catch(() => "denied" as const)
    : "denied";
  return { ...value, permission };
}
export async function destinationDirectory(id: string) {
  const handle = await read<FileSystemDirectoryHandle>(id);
  if (
    !handle ||
    (await handle.queryPermission({ mode: "readwrite" })) !== "granted"
  )
    throw new Error(
      "Доступ к папке сохранения потерян. Выберите папку заново вверху панели.",
    );
  return handle;
}

export async function writeVideoFile(
  directory: FileSystemDirectoryHandle,
  input: Blob,
  filename: string,
  {
    signal,
    onProgress,
  }: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {},
) {
  if (!filename || /[\\/\x00-\x1f]/.test(filename))
    throw new Error("Недопустимое имя файла.");
  const dot = filename.lastIndexOf("."),
    stem = dot > 0 ? filename.slice(0, dot) : filename,
    extension = dot > 0 ? filename.slice(dot) : "";
  let name, handle;
  for (let index = 0; index < 10000; index++) {
    name = index ? `${stem} (${index})${extension}` : filename;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      handle = await directory.getFileHandle(name, { create: true });
      break;
    }
  }
  if (!handle) throw new Error("Не удалось подобрать свободное имя файла.");
  let writable, reader;
  try {
    if (signal?.aborted)
      throw new DOMException("Сохранение отменено.", "AbortError");
    writable = await handle.createWritable();
    reader = input.stream().getReader();
    let bytes = 0,
      last = 0;
    while (true) {
      if (signal?.aborted)
        throw new DOMException("Сохранение отменено.", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      bytes += value.byteLength;
      if (Date.now() - last > 300) {
        onProgress?.(bytes);
        last = Date.now();
      }
    }
    if (signal?.aborted)
      throw new DOMException("Сохранение отменено.", "AbortError");
    onProgress?.(bytes);
    await writable.close();
    writable = undefined;
    return { filename: name, bytes };
  } catch (error) {
    await writable?.abort().catch(() => {});
    await directory.removeEntry(name).catch(() => {});
    throw error;
  } finally {
    await reader?.cancel().catch(() => {});
  }
}
