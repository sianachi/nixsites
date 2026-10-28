import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readGhostTextSetting,
  useGhostTextPreference,
} from '@nix/web-editor/editor/ghost-text-preference';
import { useKeyboardModeStore } from '@nix/web-editor/editor/keyboard-mode-store';
import { usePageGuidePreference } from '@nix/web-editor/editor/page-guide-preference';
import { readDismissals, rememberDismissal } from '@nix/web-foundation/lib/suggestion-dismissals';
import { memoryStorage } from '../../memory-storage';
import { EditorPreferencesSection } from '@nix/web-settings/settings/editor/editor-preferences-section';
import { PreferencesSection } from '@nix/web-settings/settings/preferences/PreferencesSection';
import {
  usePublishingPreference,
  useSitesVisible,
} from '@nix/web-settings/settings/publishing/publishing-preference';
import {
  CapabilitiesProvider,
  NO_CAPABILITIES,
} from '@nix/web-platform/session/capabilities-context';
import {
  readChoiceOrderSetting,
  readViewSuggestionSetting,
  useChoiceOrderPreference,
  useViewSuggestionPreference,
} from '@nix/web-foundation/lib/suggestion-preferences';

describe('editor preferences', () => {
  beforeEach(() => {
    useKeyboardModeStore.setState({ mode: 'standard', persistence: 'stored' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers one mutually exclusive keyboard mode and says where it is stored', () => {
    render(<EditorPreferencesSection />);

    expect(screen.getByRole('combobox', { name: 'Keyboard mode' })).toHaveValue('standard');
    expect(
      screen.getByText('The editor and platform shortcuts shown throughout Nix'),
    ).toBeVisible();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Standard',
      'Vim basics',
      'Emacs basics',
    ]);
  });

  it('states the exact boundary of Vim basics', async () => {
    const user = userEvent.setup();
    render(<EditorPreferencesSection />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Keyboard mode' }), 'vim');

    expect(
      screen.getByText(/h\/l by character, j\/k by line, w\/b\/e by word/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Operators d, c and y take a motion, a text object/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Visual \(v\) and Visual Line \(V\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Not included: Visual Block, uppercase marks/i)).toBeInTheDocument();
  });

  it('applies the choice immediately and explains its scope', async () => {
    const user = userEvent.setup();
    render(<EditorPreferencesSection />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Keyboard mode' }), 'emacs');

    expect(useKeyboardModeStore.getState().mode).toBe('emacs');
    expect(
      screen.getByText(/Ctrl\+F\/B and Alt\+F\/B move by character and word/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/the browser keeps Ctrl\+N, Ctrl\+T and Ctrl\+W/i)).toBeInTheDocument();
    expect(screen.getByText(/Ctrl\+S and Ctrl\+R search as you type/i)).toBeInTheDocument();
  });

  it('announces when a new choice cannot be remembered', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    render(<EditorPreferencesSection />);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Keyboard mode' }), 'emacs');

    expect(status).toHaveTextContent(/may reset when this page reloads/i);
  });

  it('does not imply that the Standard default will be lost without storage', () => {
    useKeyboardModeStore.setState({ mode: 'standard', persistence: 'session-only' });
    render(<EditorPreferencesSection />);

    expect(screen.getByRole('status')).toHaveTextContent(/Standard remains the default/i);
  });

  it('names a session-only Vim choice accurately', () => {
    useKeyboardModeStore.setState({ mode: 'vim', persistence: 'session-only' });
    render(<EditorPreferencesSection />);

    expect(screen.getByRole('status')).toHaveTextContent(/Vim basics may reset/i);
  });
});

function SiteEntryProbe() {
  return useSitesVisible() ? <button type="button">Publish as a site</button> : null;
}

describe('publishing', () => {
  beforeEach(() => {
    usePublishingPreference.setState({ enabled: false });
  });

  it('is not an editor preference; it has its own section', () => {
    render(
      <CapabilitiesProvider value={{ ...NO_CAPABILITIES, sites: true }}>
        <EditorPreferencesSection />
      </CapabilitiesProvider>,
    );

    expect(
      screen.queryByRole('checkbox', { name: 'Show publishing on pages' }),
    ).not.toBeInTheDocument();
  });

  it('is off by default, and switching it on and off shows and hides the site entry', async () => {
    const user = userEvent.setup();
    render(
      <CapabilitiesProvider value={{ ...NO_CAPABILITIES, sites: true }}>
        <PreferencesSection />
        <SiteEntryProbe />
      </CapabilitiesProvider>,
    );

    const toggle = screen.getByRole('checkbox', { name: 'Show publishing on pages' });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText('Adds Publish as a site to the page menu and the item panel'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Publish as a site' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Publish as a site' })).toBeVisible();

    await user.click(toggle);
    expect(screen.queryByRole('button', { name: 'Publish as a site' })).not.toBeInTheDocument();
  });

  it('offers no toggle when the deployment has no sites', () => {
    render(<PreferencesSection />);

    expect(
      screen.queryByRole('checkbox', { name: 'Show publishing on pages' }),
    ).not.toBeInTheDocument();
  });

  it('shows nothing when publishing is on but the deployment has no sites', () => {
    usePublishingPreference.setState({ enabled: true });
    render(
      <CapabilitiesProvider value={NO_CAPABILITIES}>
        <SiteEntryProbe />
      </CapabilitiesProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Publish as a site' })).not.toBeInTheDocument();
  });
});

describe('device-only rows', () => {
  it('say so on the mobile toolbar toggle and nowhere else', () => {
    render(<EditorPreferencesSection />);

    const captions = screen.getAllByText('This device only');
    expect(captions).toHaveLength(1);
    expect(screen.queryByText('This device only', { selector: 'label *' })).toBeNull();
  });

  it('is absent from a synced setting', () => {
    render(
      <CapabilitiesProvider value={{ ...NO_CAPABILITIES, sites: true }}>
        <PreferencesSection />
      </CapabilitiesProvider>,
    );

    expect(screen.getByRole('checkbox', { name: 'Show publishing on pages' })).toBeInTheDocument();
    expect(screen.queryByText('This device only')).not.toBeInTheDocument();
  });
});

describe('page guides', () => {
  it('are shown by default and can be switched off', async () => {
    const user = userEvent.setup();
    usePageGuidePreference.setState({ visibility: 'shown', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Show page guides' });
    expect(toggle).toBeChecked();
    expect(screen.getByText('Marks where PDF and Word exports start a new page')).toBeVisible();

    await user.click(toggle);

    expect(usePageGuidePreference.getState().visibility).toBe('hidden');
    expect(toggle).not.toBeChecked();
  });
});

describe('phrase suggestions', () => {
  it('are off until asked for, and say how to accept and where they learn', async () => {
    const user = userEvent.setup();
    useGhostTextPreference.setState({ setting: 'off', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Suggest phrase completions' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Press Right Arrow to accept/i)).toBeInTheDocument();
    expect(screen.getByText(/in memory only/i)).toBeInTheDocument();

    await user.click(toggle);

    expect(useGhostTextPreference.getState().setting).toBe('on');
    expect(toggle).toBeChecked();
  });

  it('read as off when nothing, or anything unexpected, is stored', () => {
    expect(readGhostTextSetting(undefined)).toBe('off');
    const storage = { getItem: () => 'maybe' } as unknown as Storage;
    expect(readGhostTextSetting(storage)).toBe('off');
  });
});

describe('suggestion switches', () => {
  it('turn view suggestions off and describe what they cover', async () => {
    const user = userEvent.setup();
    useViewSuggestionPreference.setState({ setting: 'on', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Suggestions in views' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/hints that views offer/i);

    await user.click(toggle);

    expect(useViewSuggestionPreference.getState().setting).toBe('off');
  });

  it('turn ordering by picks off and describe what it covers', async () => {
    const user = userEvent.setup();
    useChoiceOrderPreference.setState({ setting: 'on', saved: true });
    render(<EditorPreferencesSection />);

    const toggle = screen.getByRole('checkbox', { name: 'Order choices by what I pick most' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/usual picks first/i);

    await user.click(toggle);

    expect(useChoiceOrderPreference.getState().setting).toBe('off');
  });

  it('clear dismissed suggestions so they can come back', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('localStorage', memoryStorage());
    rememberDismissal('mention:workspace-1:item-1');
    render(<EditorPreferencesSection />);

    await user.click(screen.getByRole('button', { name: 'Clear dismissed suggestions' }));

    expect(readDismissals().size).toBe(0);
    expect(screen.getByText('Dismissed suggestions cleared.')).toBeInTheDocument();
  });

  it('reports a refused dismissal reset and keeps the dismissals for retry', async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    rememberDismissal('mention:workspace-1:item-1');
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('Storage refused');
    });
    render(<EditorPreferencesSection />);

    await user.click(screen.getByRole('button', { name: 'Clear dismissed suggestions' }));

    expect(readDismissals().size).toBe(1);
    expect(
      screen.getByText('Browser storage could not clear dismissed suggestions. Try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Dismissed suggestions cleared.')).not.toBeInTheDocument();
  });

  it('describe every switch to assistive technology', () => {
    render(<EditorPreferencesSection />);

    for (const name of [
      'Hide mobile tools while writing',
      'Show page guides',
      'Suggest phrase completions',
      'Underline item names that are not linked',
    ]) {
      expect(screen.getByRole('checkbox', { name })).toHaveAccessibleDescription(/\w/);
    }
  });

  it('say that phrase completions need a keyboard', () => {
    render(<EditorPreferencesSection />);

    expect(
      screen.getByRole('checkbox', { name: 'Suggest phrase completions' }),
    ).toHaveAccessibleDescription(/needs a keyboard/i);
  });

  it('read as on when nothing, or anything unexpected, is stored', () => {
    expect(readViewSuggestionSetting(undefined)).toBe('on');
    expect(readChoiceOrderSetting(undefined)).toBe('on');
    const storage = { getItem: () => 'maybe' } as unknown as Storage;
    expect(readViewSuggestionSetting(storage)).toBe('on');
  });
});
