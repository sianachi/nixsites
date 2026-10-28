/**
 * Server-sent events, read off a byte stream.
 *
 * `EventSource` cannot do the one thing the inline writing request needs: it only issues GETs, and
 * it cannot carry a bearer header. So the response of an ordinary authenticated `fetch` is framed
 * here instead, by the rules of the SSE format and nothing else - no knowledge of what any event
 * means.
 *
 * Bytes arrive in whatever pieces the network chose, so a line, a CRLF pair or a single multi-byte
 * character can be split across two chunks; the decoder is told the stream continues, and a
 * trailing carriage return is held back until the next chunk shows whether a line feed follows it.
 * An event still unterminated when the stream ends is dropped, as the format specifies: it was
 * never completed, so it was never sent.
 */

export interface SseRecord {
  /** The `event:` field, or `message` when the record names none. */
  readonly event: string;
  /** Every `data:` line, joined with a line feed. */
  readonly data: string;
}

/** Bounds unfinished lines and records, including a sender that never supplies a terminator. */
export const MAX_SSE_RECORD_CHARS = 256 * 1024;

const LINE_BREAK = /\r\n|\n|\r/;

export async function* readSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseRecord, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let started = false;
  let event = '';
  let data: string[] = [];
  let recordChars = 0;

  function* feed(lines: readonly string[]): Generator<SseRecord, void, undefined> {
    for (const line of lines) {
      if (line === '') {
        // A blank line ends the record. A record with no data is not dispatched.
        if (data.length > 0)
          yield { event: event === '' ? 'message' : event, data: data.join('\n') };
        event = '';
        data = [];
        recordChars = 0;
        continue;
      }
      recordChars += line.length + 1;
      if (recordChars > MAX_SSE_RECORD_CHARS)
        throw new RangeError('The SSE record exceeded its size limit.');
      // A comment: the server's keep-alive, which says nothing and is not a field.
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      // `id` and `retry` have no meaning to a one-shot request.
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!started && buffer.length > 0) {
        started = true;
        if (buffer.startsWith('﻿')) buffer = buffer.slice(1);
      }

      if (done) {
        // Whatever is left has no line ending, so it is an incomplete line of an incomplete
        // record; a lone trailing CR is the one case that was a complete line.
        if (buffer.endsWith('\r')) yield* feed(buffer.slice(0, -1).split(LINE_BREAK));
        return;
      }

      // A CR at the very end may be the first half of a CRLF; wait for the next chunk to say.
      const heldBack = buffer.endsWith('\r') ? '\r' : '';
      const complete = heldBack === '' ? buffer : buffer.slice(0, -1);
      const lines = complete.split(LINE_BREAK);
      buffer = (lines.pop() ?? '') + heldBack;
      yield* feed(lines);
      if (recordChars + buffer.length > MAX_SSE_RECORD_CHARS)
        throw new RangeError('The SSE record exceeded its size limit.');
    }
  } finally {
    // Stops the download if the consumer walks away early; harmless once it has finished.
    await reader.cancel().catch(() => undefined);
  }
}
