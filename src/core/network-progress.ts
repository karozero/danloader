export function observeResponse(
  response: Response,
  onBytes: (bytes: number) => void,
): Response {
  if (!response.body) return response;
  const stream = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
  const wrapped = new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const key of ["url", "redirected", "type"])
    Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}
export function sabrPercent({
  bytes,
  totalBytes,
  duration,
  videoEnd,
  audioEnd,
}: {
  bytes: number;
  totalBytes?: number;
  duration?: number;
  videoEnd?: number;
  audioEnd?: number;
}): number | null {
  if (totalBytes > 0)
    return Math.min(99, Math.max(0, (bytes / totalBytes) * 100));
  if (duration > 0)
    return Math.min(
      99,
      Math.max(
        0,
        (Math.min(videoEnd || 0, audioEnd || 0) / (duration * 1000)) * 100,
      ),
    );
  return null;
}
