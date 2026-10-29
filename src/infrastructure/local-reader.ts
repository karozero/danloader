// Keep local mux input on disk. FFmpeg's small reads share one synchronous block.
export function cachedFileReader(
  handle: Pick<FileSystemSyncAccessHandle, "read">,
  size: number,
  blockSize = 1024 * 1024,
) {
  let cached;
  return (position: number) => {
    if (!Number.isSafeInteger(position) || position < 0)
      throw new Error("Недопустимая позиция чтения.");
    if (position >= size) return { position, data: new Uint8Array() };
    if (
      cached &&
      position >= cached.position &&
      position < cached.position + cached.data.length
    )
      return cached;
    const start = Math.floor(position / blockSize) * blockSize;
    const data = new Uint8Array(Math.min(blockSize, size - start));
    let loaded = 0;
    while (loaded < data.length) {
      const count = handle.read(data.subarray(loaded), { at: start + loaded });
      if (!count)
        throw new Error("Не удалось прочитать временную дорожку целиком.");
      loaded += count;
    }
    cached = { position: start, data };
    return cached;
  };
}

export async function mountLocalInputs(av, root, files) {
  const handles = [],
    readers = new Map();
  try {
    for (const { name, file } of files) {
      const handle = await root.getFileHandle(file);
      const { size } = await handle.getFile();
      const sync = await handle.createSyncAccessHandle();
      handles.push(sync);
      readers.set(name, cachedFileReader(sync, size));
      await av.mkblockreaderdev(name, size);
    }
    av.onblockread = (name, position) => {
      const read = readers.get(name);
      if (!read) throw new Error("Неизвестная временная дорожка.");
      const block = read(position);
      return av.ff_block_reader_dev_send(name, block.position, block.data);
    };
    return () => {
      for (const handle of handles) handle.close();
    };
  } catch (error) {
    for (const handle of handles) handle.close();
    throw error;
  }
}
