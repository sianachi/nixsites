import { Button, Dialog, Icon, Segmented, Select, Text } from '@nix/ui';
import { FileText, Palette } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ThemePaletteSchema, type Ground, type ThemePalette } from './theme-store';
import { useTheme, type Theme } from './use-theme';

const MODES: readonly { value: Ground; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeButton(): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon icon={Palette} size="sm" />
        Theme
      </Button>
      <ThemeChoice
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

export function ThemeChoice({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const theme = useTheme();
  return open ? <ThemeDraft theme={theme} onClose={onClose} /> : null;
}

function ThemeDraft({ theme, onClose }: { theme: Theme; onClose: () => void }): ReactNode {
  const [mode, setMode] = useState(theme.mode);
  const [palette, setPalette] = useState(theme.palette);
  const ground = mode ?? theme.ground;

  return (
    <Dialog
      open
      title="Theme"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={mode === theme.mode && palette === theme.palette}
            onClick={() => {
              theme.setTheme(mode, palette);
              onClose();
            }}
          >
            Apply theme
          </Button>
        </>
      }
    >
      <ThemeFields ground={ground} palette={palette} onMode={setMode} onPalette={setPalette} />
    </Dialog>
  );
}

export function ThemeFields({
  ground,
  palette,
  onMode,
  onPalette,
}: {
  readonly ground: Ground;
  readonly palette: ThemePalette;
  readonly onMode: (mode: Ground) => void;
  readonly onPalette: (palette: ThemePalette) => void;
}): ReactNode {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Text variant="caption" tone="muted">
            Mode
          </Text>
          <Segmented label="Mode" options={MODES} value={ground} onChange={onMode} />
        </div>
        <label className="min-w-0 space-y-1">
          <Text as="span" variant="caption" tone="muted" className="block">
            Palette
          </Text>
          <Select
            value={palette}
            onChange={(event) => {
              const parsed = ThemePaletteSchema.safeParse(event.currentTarget.value);
              if (parsed.success) onPalette(parsed.data);
            }}
          >
            {ThemePaletteSchema.options.map((option) => (
              <option key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <section aria-label="Theme preview" className="space-y-1">
        <Text variant="caption" tone="muted">
          Preview
        </Text>
        <div
          data-theme-preview=""
          data-theme={ground}
          data-palette={palette === 'nix' ? undefined : palette}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] overflow-hidden rounded-md border border-divider bg-background"
        >
          <div className="space-y-2 border-r border-divider bg-surface p-3">
            <Text variant="caption" tone="muted">
              Workspace
            </Text>
            <div className="flex items-center gap-1.5 rounded-sm border-l-2 border-accent bg-background px-1.5 py-1">
              <Icon icon={FileText} size="sm" className="text-foreground" />
              <Text as="span" variant="bodySmall">
                Notes
              </Text>
            </div>
          </div>
          <div className="space-y-1 p-3">
            <Text as="p" variant="h4">
              Launch brief
            </Text>
            <Text variant="bodySmall" tone="muted">
              Plan the work and keep the details together.
            </Text>
          </div>
        </div>
      </section>
    </div>
  );
}
