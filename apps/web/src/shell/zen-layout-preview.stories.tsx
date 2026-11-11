import { Button, Text, UndoProvider } from '@nix/ui';
import type { ReactNode } from 'react';

import { useZenLayoutPreview, ZenLayoutPreview } from './zen-layout-preview';

export default { title: 'Nix/Shell/Preferences' };

function Example({ narrow }: { readonly narrow: boolean }): ReactNode {
  const preview = useZenLayoutPreview(null, { explorer: true, navigation: true, status: true });
  return (
    <div className="flex justify-between gap-4">
      <Text as="p">{preview.explorer ? 'Explorer and collection' : 'Collection'}</Text>
      <ZenLayoutPreview
        preview={preview}
        narrow={narrow}
        anchor={(ref) => (
          <Button ref={ref} variant="secondary" onClick={preview.open}>
            Preferences
          </Button>
        )}
      />
    </div>
  );
}

function sample(narrow: boolean): ReactNode {
  return (
    <UndoProvider>
      <Example narrow={narrow} />
    </UndoProvider>
  );
}

function openPreferences({ canvasElement }: { readonly canvasElement: HTMLElement }): void {
  const button = canvasElement.querySelector('button');
  if (button === null) throw new Error('The Preferences trigger was not rendered.');
  button.click();
}

export const Layouts = { render: (): ReactNode => sample(false), play: openPreferences };
export const PhoneLayouts = { render: (): ReactNode => sample(true), play: openPreferences };
