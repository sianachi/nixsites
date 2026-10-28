import { Button, Dialog, Text } from '@nix/ui';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
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
