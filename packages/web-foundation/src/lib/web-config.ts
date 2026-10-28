import { createContext, use } from 'react';
import { z } from 'zod';

/**
 * Per-install switches for the public front door, served by the web container's Caddy as
 * `/web-config.json` (deploy/k8s/Caddyfile). Both are off unless the install turns them on.
 */
export interface WebConfig {
  /** Anonymous visitors to `/` see the landing page instead of the sign-in card. */
  readonly landing: boolean;
  /** `/demo` draws the views over sample data held in the browser. */
  readonly demo: boolean;
}

export const WEB_CONFIG_OFF: WebConfig = { landing: false, demo: false };

const webConfigSchema = z.object({ landing: z.boolean(), demo: z.boolean() });

/**
 * Reads the switches once at boot. Anything but a clean answer leaves both off: an install that
 * does not serve the file answers with the SPA's index.html, which is not JSON.
 */
export async function loadWebConfig(): Promise<WebConfig> {
  try {
    const response = await fetch('/web-config.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return WEB_CONFIG_OFF;
    const parsed = webConfigSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : WEB_CONFIG_OFF;
  } catch {
    return WEB_CONFIG_OFF;
  }
}

export const WebConfigContext = createContext<WebConfig>(WEB_CONFIG_OFF);

export function useWebConfig(): WebConfig {
  return use(WebConfigContext);
}
