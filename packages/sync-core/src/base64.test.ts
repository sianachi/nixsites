import { describe, expect, it } from 'vitest';
import { byteLength, fromByteArray, toByteArray } from './base64.js';

describe('base64', () => {
  it('round-trips every byte value and large buffers', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toByteArray(fromByteArray(all))).toEqual(all);
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(toByteArray(fromByteArray(big))).toEqual(big);
  });

  it('matches the standard encoding and measures decoded length', () => {
    expect(fromByteArray(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
    expect(byteLength('aGVsbG8=')).toBe(5);
    expect(byteLength('aGVsbA==')).toBe(4);
    expect(byteLength('')).toBe(0);
  });
});
