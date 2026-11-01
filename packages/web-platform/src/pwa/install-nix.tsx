import { Button, Dialog, Text } from '@nix/ui';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
/** Capacitor's bridge, which the iOS shell (apps/mobile) injects into the server pages it opens. */
const shell = (
  globalThis as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
    };
  }
).Capacitor;
/** Whether this page runs inside the iOS shell rather than a browser. */
export const inNativeShell = shell?.isNativePlatform?.() === true;
function native(plugin: string, method: string, options?: object): void {
  // An older shell build may lack the plugin; nothing on the page depends on the answer.
  void shell?.nativePromise?.(plugin, method, options).catch(() => undefined);
}
/** Back to the shell's server picker. */
export function switchServer(): void {
  native('NixShell', 'showPicker');
}
if (inNativeShell && typeof document !== 'undefined') {
  // The previous / next / done bar above the keyboard is browser chrome a native app does not show.
  native('Keyboard', 'setAccessoryBarVisible', { isVisible: false });
  // Status bar text follows the app's own theme (data-theme, or the system when unset), which can
  // differ from the system's. Capacitor's DARK style is light text, for a dark ground.
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const syncStatusBar = (): void => {
    const ground =
      document.documentElement.getAttribute('data-theme') ??
      (systemDark.matches ? 'dark' : 'light');
    native('StatusBar', 'setStyle', { style: ground === 'dark' ? 'DARK' : 'LIGHT' });
  };
  syncStatusBar();
  systemDark.addEventListener('change', syncStatusBar);
  new MutationObserver(syncStatusBar).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

let installPrompt: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
// Capture before the session and workspace requests complete.
if (typeof window !== 'undefined')
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    for (const listener of installListeners) listener();
  });
function subscribeInstall(listener: () => void): () => void {
  installListeners.add(listener);
  return () => {
    installListeners.delete(listener);
  };
}

/** Installing Nix as an app, offered from the profile menu: the browser's prompt when it gave
 * one, else a dialog with the manual steps. `offer` is false once running installed. */
export function useInstallNix(): {
  readonly offer: boolean;
  readonly install: () => void;
  readonly dialog: ReactNode;
} {
  const prompt = useSyncExternalStore(
    subscribeInstall,
    () => installPrompt,
    () => null,
  );
  const [help, setHelp] = useState(false);
  const [installed, setInstalled] = useState(
    () =>
      inNativeShell ||
      window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && navigator.standalone === true),
  );
  useEffect(() => {
    const installedNow = (): void => {
      setInstalled(true);
      installPrompt = null;
    };
    window.addEventListener('appinstalled', installedNow);
    return () => {
      window.removeEventListener('appinstalled', installedNow);
    };
  }, []);
  const install = (): void => {
    if (prompt)
      void prompt
        .prompt()
        .then(() => prompt.userChoice)
        .then((choice) => {
          installPrompt = null;
          for (const listener of installListeners) listener();
          if (choice.outcome === 'accepted') setInstalled(true);
        })
        .catch(() => {
          setHelp(true);
        });
    else setHelp(true);
  };
  const dialog = (
    <Dialog
      open={help}
      onClose={() => {
        setHelp(false);
      }}
      title="Install Nix"
    >
      <Text as="p" variant="body">
        On iPhone or iPad, open the browser’s Share menu, choose Add to Home Screen, and keep Open
        as Web App enabled if offered.
      </Text>
      <Text as="p" variant="body">
        On Android or desktop, open the browser menu and choose Install app or Add to Home screen.
        Installation needs a secure HTTPS connection.
      </Text>
      <Button
        onClick={() => {
          setHelp(false);
        }}
      >
        Done
      </Button>
    </Dialog>
  );
  return { offer: !installed, install, dialog };
}
