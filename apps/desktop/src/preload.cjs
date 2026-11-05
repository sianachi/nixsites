const { contextBridge, ipcRenderer } = require('electron');

// Runs in every top-level page, sandboxed; nothing here is trusted. The main process checks each
// call against the sending frame, so a page that should not have these gets refusals.

/** Rejects with the plain string, as WebKit does: the page tests for 'cancelled'. */
async function call(channel, body) {
  const { value, error } = await ipcRenderer.invoke(channel, body);
  if (error !== undefined) throw error;
  return value;
}

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('nixPicker', (request) => call('nix:picker', request));
} else {
  // The names the web app already looks for in the iOS shell (packages/sync-sqlite/src/webkit-driver.ts,
  // packages/web-platform/src/auth/native-sign-in.ts and pwa/install-nix.tsx), so it needs no desktop branch.
  contextBridge.exposeInMainWorld('webkit', {
    messageHandlers: {
      nixStore: { postMessage: (request) => call('nix:store', request) },
      nixSignIn: { postMessage: (request) => call('nix:signIn', request) },
    },
  });
  contextBridge.exposeInMainWorld('Capacitor', {
    isNativePlatform: () => true,
    // The page also styles the iOS keyboard and status bar; there is nothing to do for those here.
    nativePromise: (plugin, method) =>
      plugin === 'NixShell' && method === 'showPicker'
        ? call('nix:showPicker')
        : Promise.resolve(undefined),
  });
}
