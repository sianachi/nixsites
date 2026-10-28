import { Button, Text } from '@nix/ui';
import { Keyboard, Maximize2, PanelLeft } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { CommandPalette } from './command-palette';
import type { PaletteCommand } from './commands';

export default { title: 'Nix/Search/Command palette', parameters: { layout: 'fullscreen' } };

function Example(): ReactNode {
  const [open, setOpen] = useState(true);
  const [lastCommand, setLastCommand] = useState('Choose a command with the arrow keys and Enter.');
  const commands: readonly PaletteCommand[] = [
    {
      id: 'sidebar',
      label: 'Show or hide the sidebar',
      hint: 'Workspace navigation',
      icon: PanelLeft,
      keywords: ['sidebar'],
      run: () => {
        setLastCommand('Sidebar command selected.');
      },
    },
    {
      id: 'zen',
      label: 'Toggle Zen mode',
      hint: 'Current page, with workspace navigation hidden',
      icon: Maximize2,
      keywords: ['focus', 'zen'],
      run: () => {
        setLastCommand('Zen command selected.');
      },
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: Keyboard,
      keywords: ['keyboard', 'shortcuts'],
      run: () => {
        setLastCommand('Keyboard shortcuts selected.');
      },
    },
  ];
  return (
    <AuthProvider>
      <ApiClientProvider>
        <div className="min-h-dvh bg-background p-4 text-foreground">
          <Button
            onClick={() => {
              setOpen(true);
            }}
          >
            Search and commands
          </Button>
          <Text as="p" variant="bodySmall" className="mt-3">
            {lastCommand}
          </Text>
        </div>
        <CommandPalette
          open={open}
          commands={commands}
          onClose={() => {
            setOpen(false);
          }}
          onSelectItem={() => undefined}
        />
      </ApiClientProvider>
    </AuthProvider>
  );
}

export const KeyboardNavigation = { render: (): ReactNode => <Example /> };
export const DarkKeyboardNavigation = { ...KeyboardNavigation, globals: { ground: 'dark' } };
