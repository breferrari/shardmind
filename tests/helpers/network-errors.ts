/**
 * The errors Node's fetch (undici) raises, for tests of network failures
 * (#380, #385): a `TypeError` with the socket error, carrying its `code`, on
 * `cause`. `fetch failed` is a request that could not be made; `terminated`
 * is a body whose connection dropped while it was read.
 */
export function fetchTypeError(message: 'fetch failed' | 'terminated', code: string): TypeError {
  return new TypeError(message, { cause: Object.assign(new Error(`socket error ${code}`), { code }) });
}

/** A 200 whose body sends `head` (if any), then fails as a connection dropped mid-transfer does. */
export function droppedResponse(head?: Uint8Array): Response {
  const drop = fetchTypeError('terminated', 'UND_ERR_SOCKET');
  return new Response(
    new ReadableStream({
      start(controller) {
        if (head) controller.enqueue(head);
        controller.error(drop);
      },
    }),
    { status: 200 },
  );
}
