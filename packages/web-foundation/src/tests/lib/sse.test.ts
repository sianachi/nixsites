import { describe, expect, it, vi } from 'vitest';

import { MAX_SSE_RECORD_CHARS, readSse, type SseRecord } from '../../lib/sse';

/**
 * The SSE framer against byte streams cut where a network would cut them.
 *
 * The inline writing request is the only caller, and a delta it mis-frames is a corrupted result
 * the person may accept into their note, so the framing rules are pinned one by one rather than
 * left to the happy path of a single chunk.
 */

const encoder = new TextEncoder();

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(chunks: readonly Uint8Array[]): Promise<SseRecord[]> {
  const records: SseRecord[] = [];
  for await (const record of readSse(streamOf(chunks))) records.push(record);
  return records;
}

function splitAt(bytes: Uint8Array, offset: number): Uint8Array[] {
  return [bytes.slice(0, offset), bytes.slice(offset)];
}

describe('readSse', () => {
  it('bounds a sender that never terminates a line or event and cancels its stream', async () => {
    const cancel = vi.fn();
    const unfinished = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: ' + 'x'.repeat(MAX_SSE_RECORD_CHARS + 1)));
      },
      cancel,
    });
    await expect(readSse(unfinished).next()).rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reads one event with its name and data', async () => {
    expect(await collect([encoder.encode('event: delta\ndata: {"text":"hi"}\n\n')])).toEqual([
      { event: 'delta', data: '{"text":"hi"}' },
    ]);
  });

  it('gives a record that names no event the name "message"', async () => {
    // The format's default; a caller switching on event names must see something, not ''.
    expect(await collect([encoder.encode('data: plain\n\n')])).toEqual([
      { event: 'message', data: 'plain' },
    ]);
  });

  it('frames the same events however the bytes are split, at every offset', async () => {
    const bytes = encoder.encode(
      'event: delta\ndata: one\n\nevent: delta\ndata: two\n\nevent: done\ndata: three\n\n',
    );
    const expected = [
      { event: 'delta', data: 'one' },
      { event: 'delta', data: 'two' },
      { event: 'done', data: 'three' },
    ];

    for (let offset = 0; offset <= bytes.length; offset += 1) {
      expect(await collect(splitAt(bytes, offset)), `split at byte ${String(offset)}`).toEqual(
        expected,
      );
    }
  });

  it('frames CRLF input the same way at every split, including between the CR and the LF', async () => {
    const bytes = encoder.encode(
      'event: delta\r\ndata: one\r\n\r\nevent: done\r\ndata: two\r\n\r\n',
    );
    const expected = [
      { event: 'delta', data: 'one' },
      { event: 'done', data: 'two' },
    ];

    for (let offset = 0; offset <= bytes.length; offset += 1) {
      expect(await collect(splitAt(bytes, offset)), `split at byte ${String(offset)}`).toEqual(
        expected,
      );
    }
  });

  it('does not read a CR LF pair as two line breaks', async () => {
    // Two breaks would be a blank line, which would dispatch the record before its data.
    expect(
      await collect([encoder.encode('event: a\r\n'), encoder.encode('data: x\r\n\r\n')]),
    ).toEqual([{ event: 'a', data: 'x' }]);
  });

  it('accepts a lone CR as a line break', async () => {
    expect(await collect([encoder.encode('data: x\r\r')])).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('keeps a multi-byte character whole when its bytes arrive in separate chunks', async () => {
    const text = 'café 世界 😀';
    const bytes = encoder.encode(`event: delta\ndata: ${text}\n\n`);

    // Every offset, so the split falls inside the 2-, 3- and 4-byte characters in turn.
    for (let offset = 0; offset <= bytes.length; offset += 1) {
      const records = await collect(splitAt(bytes, offset));
      expect(records, `split at byte ${String(offset)}`).toEqual([{ event: 'delta', data: text }]);
    }
  });

  it('delivers one byte at a time without corrupting anything', async () => {
    const bytes = encoder.encode('event: delta\ndata: naïve 😀\n\n');
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));

    expect(await collect(chunks)).toEqual([{ event: 'delta', data: 'naïve 😀' }]);
  });

  it('ignores comment lines, which are the server keep-alive', async () => {
    expect(
      await collect([encoder.encode(': keep-alive\n\nevent: delta\n: again\ndata: x\n\n')]),
    ).toEqual([{ event: 'delta', data: 'x' }]);
  });

  it('does not dispatch a record that carries no data', async () => {
    expect(await collect([encoder.encode('event: delta\n\n: ping\n\n')])).toEqual([]);
  });

  it('joins several data lines with a line feed', async () => {
    expect(await collect([encoder.encode('data: one\ndata: two\ndata:three\n\n')])).toEqual([
      { event: 'message', data: 'one\ntwo\nthree' },
    ]);
  });

  it('removes exactly one space after the colon', async () => {
    expect(await collect([encoder.encode('data:  two spaces\n\n')])).toEqual([
      { event: 'message', data: ' two spaces' },
    ]);
  });

  it("does not let one record's event name leak into the next", async () => {
    expect(await collect([encoder.encode('event: error\ndata: a\n\ndata: b\n\n')])).toEqual([
      { event: 'error', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('drops an event still unterminated when the stream ends', async () => {
    // It was never completed, so by the format it was never sent; a half-delivered "done" must
    // not be taken as the result.
    expect(
      await collect([encoder.encode('event: delta\ndata: whole\n\nevent: done\ndata: half')]),
    ).toEqual([{ event: 'delta', data: 'whole' }]);
    expect(await collect([encoder.encode('event: done\ndata: complete line\n')])).toEqual([]);
  });

  it('strips a byte order mark from the start of the stream', async () => {
    expect(await collect([encoder.encode('﻿data: x\n\n')])).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });
});
