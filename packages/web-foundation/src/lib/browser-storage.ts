/**
 * The storage the application actually has, if it has one.
 *
 * **The DOM types declare `localStorage` as always present, and that is not true.** It throws on
 * an opaque origin, it is absent when this code is evaluated outside a browser, and a test
 * environment can leave an object there with no methods on it. So the return type is honest where
 * the platform's is not, and every caller is made to handle its absence.
 *
 * Checked by feature rather than by existence for the same reason: an object that exists and
 * cannot `getItem` is exactly as useful as no object, and only one of those two is what the type
 * would have you check for.
 *
 * It lives in `lib/` rather than in `theme/`, where it was first written, because four different
 * folders import it and none of them is about theming - a shared utility parked in whichever
 * feature happened to need it first. It meets this folder's convention exactly as
 * `async-status.ts` states it: dependency-free, framework-agnostic, no React, so it stays testable
 * as a plain function.
 */
export function browserStorage(): Storage | undefined {
  try {
    const candidate: unknown = globalThis.localStorage;

    return typeof (candidate as Storage | undefined)?.getItem === 'function'
      ? (candidate as Storage)
      : undefined;
  } catch {
    // An opaque origin, or a policy that blocks storage outright. Both throw on access rather
    // than returning nothing, which is why this is a try and not a check.
    return undefined;
  }
}

/** Tab-scoped storage for unfinished flows that must not reappear in another browser session. */
export function browserSessionStorage(): Storage | undefined {
  try {
    const candidate: unknown = globalThis.sessionStorage;
    return typeof (candidate as Storage | undefined)?.getItem === 'function'
      ? (candidate as Storage)
      : undefined;
  } catch {
    return undefined;
  }
}
