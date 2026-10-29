import { Code2 } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { Text } from '@nix/ui';
import type { ViewKindDescriptor } from '../views/core/view-kinds';

// The OpenUI renderer is its own chunk, loaded only when a custom view is opened.
const CustomView = lazy(() => import('./custom-view'));

export const CUSTOM_VIEW_KIND: ViewKindDescriptor = {
  // A program stored in the view and drawn by the browser (ADR-0066). Its own editing lives in
  // the view editor, and exports and published sites fall back to a list: they never run it.
  kind: 'custom',
  label: 'Custom',
  icon: Code2,
  render: (props) => (
    <Suspense fallback={<Text role="status">Loading the view…</Text>}>
      <CustomView key={`${props.container.itemId ?? 'root'}:${props.view.id}`} {...props} />
    </Suspense>
  ),
  configures: [],
  chooses: [],
};
