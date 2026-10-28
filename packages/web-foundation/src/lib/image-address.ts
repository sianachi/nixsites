import { z } from 'zod';

/** The browser-fetchable image address accepted by every image surface. */
export const imageAddressSchema = z
  .string()
  .trim()
  .min(1, 'Enter an image address.')
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Enter a complete image address that starts with http:// or https://.');

/** Whether an existing value is safe to hand to a browser image fetch. */
export function isFetchableImageAddress(value: string): boolean {
  return imageAddressSchema.safeParse(value).success;
}
