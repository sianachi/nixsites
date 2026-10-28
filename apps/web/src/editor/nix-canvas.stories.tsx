import { createNixClient, type NixClient } from '@nix/api-client';
import { waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import type { CanvasElement } from './canvas-binding';
import { NixCanvas } from './nix-canvas';

const previewClient: NixClient = {
  ...createNixClient({
    baseUrl: 'http://nix.invalid',
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
  }),
  query: (endpoint) => Promise.resolve(endpoint.schema.parse({ items: [] })),
  execute: (endpoint) => Promise.resolve(endpoint.schema.parse({ items: [] })),
};

export default { title: 'Nix/Editor/Spatial canvas', parameters: { layout: 'fullscreen' } };

function Canvas(): ReactNode {
  const [elements, setElements] = useState<readonly CanvasElement[]>([]);
  return (
    <ApiClientOverrideProvider client={previewClient}>
      <div className="h-full min-w-0 w-full">
        <NixCanvas
          elements={elements}
          onChange={setElements}
          workspaceId="11111111-1111-4111-8111-111111111111"
          parentItemId="22222222-2222-4222-8222-222222222222"
        />
      </div>
    </ApiClientOverrideProvider>
  );
}

export const Desktop = {
  render: (): ReactNode => (
    <div className="h-dvh">
      <Canvas />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const workspace = canvas.getByRole('region', { name: 'Canvas workspace' });
    await canvas.findByRole('region', { name: 'Shapes' });
    await waitFor(() => {
      const canvasRect = workspace.getBoundingClientRect();
      const controls = workspace.querySelectorAll<HTMLElement>('button, .ToolIcon');
      for (const control of controls) {
        const rect = control.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (
          rect.left < canvasRect.left ||
          rect.right > canvasRect.right ||
          rect.top < canvasRect.top ||
          rect.bottom > canvasRect.bottom
        ) {
          throw new Error('Canvas controls fall outside the workspace.');
        }
      }
    });
    const addItem = canvas.queryByRole('button', { name: 'Add a Nix item to the canvas' });
    if (addItem === null) {
      await userEvent.click(canvas.getByRole('button', { name: 'Canvas actions' }));
      await userEvent.click(
        within(canvasElement.ownerDocument.body).getByRole('menuitem', {
          name: 'Add a Nix item to the canvas',
        }),
      );
    } else {
      await userEvent.click(addItem);
    }
    const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', {
      name: 'Add a Nix item',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  },
};

export const SmallCanvas = {
  render: (): ReactNode => (
    <div className="h-110 w-70 max-w-full">
      <Canvas />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const actions = await canvas.findByRole('button', { name: 'Canvas actions' });
    const workspace = canvas.getByRole('region', { name: 'Canvas workspace' });
    await waitFor(() => {
      const canvasRect = workspace.getBoundingClientRect();
      const actionRect = actions.getBoundingClientRect();
      if (
        actionRect.left < canvasRect.left ||
        actionRect.right > canvasRect.right ||
        actionRect.top < canvasRect.top ||
        actionRect.bottom > canvasRect.bottom
      ) {
        throw new Error('Canvas actions fall outside the small canvas.');
      }
      const toolbar = canvas.getByRole('region', { name: 'Shapes' });
      const toolbarRect = toolbar.getBoundingClientRect();
      if (actionRect.top < toolbarRect.bottom) {
        throw new Error('Canvas actions overlap the native drawing toolbar.');
      }
      within(toolbar).getByRole('radio', { name: /image/i });
      const targets = toolbar.querySelectorAll<HTMLElement>('.ToolIcon');
      if (targets.length === 0) throw new Error('The drawing toolbar has no touch targets.');
      for (const target of targets) {
        const targetRect = target.getBoundingClientRect();
        if (
          targetRect.left < canvasRect.left ||
          targetRect.right > canvasRect.right ||
          targetRect.top < canvasRect.top ||
          targetRect.bottom > canvasRect.bottom
        ) {
          throw new Error('Native drawing tools fall outside the small canvas.');
        }
      }
    });
    await userEvent.click(canvas.getByRole('button', { name: 'More tools' }));
    const frame = (await canvas.findByText('Frame tool')).closest('button');
    if (frame === null) throw new Error('The frame tool has no control.');
    const frameRect = frame.getBoundingClientRect();
    const frameTarget = canvasElement.ownerDocument.elementFromPoint(
      frameRect.left + frameRect.width / 2,
      frameRect.top + frameRect.height / 2,
    );
    if (!frame.contains(frameTarget)) throw new Error('The frame tool menu is covered.');
    await userEvent.click(frame);
    await userEvent.click(actions);
    within(canvasElement.ownerDocument.body).getByRole('menuitem', {
      name: 'Import an Excalidraw scene',
    });
    within(canvasElement.ownerDocument.body).getByRole('menuitem', {
      name: 'Add a Nix item to the canvas',
    });
  },
};

export const PhoneCanvas = {
  render: (): ReactNode => (
    <div className="h-110 w-82 max-w-full">
      <Canvas />
    </div>
  ),
  play: SmallCanvas.play,
};
