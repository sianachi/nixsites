import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

import {
  prepareHealthyAdmission,
  renderAt as renderRouted,
} from '@nix/web-foundation/testing/render-with-router';

import { stubHealthyCollaboration } from './healthy-collaboration';

export {
  prepareHealthyAdmission,
  resetSession,
  signedIn,
} from '@nix/web-foundation/testing/render-with-router';

/**
 * The foundation router render, with a healthy test transport for collaboration by default so
 * unrelated UI tests do not open real sockets. Pass collaboration: 'provided' when a test supplies
 * its own transport or failures.
 */
export function renderAt(
  ui: ReactElement,
  url = '/',
  { collaboration = 'healthy' }: { readonly collaboration?: 'healthy' | 'provided' } = {},
): RenderResult {
  if (collaboration === 'healthy') {
    void prepareHealthyAdmission();
    stubHealthyCollaboration();
  }
  return renderRouted(ui, url);
}
