/**
 * The origin a typed server address names, or null when the shell must not open it. Mirrors
 * `NixShellPlugin.origin` in ios/App/App/NixShell.swift, which re-checks what the picker saves.
 */
export function serverOrigin(input) {
  const text = input.trim();
  if (text === '') return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  // Plain http only for a dev stack on this machine, which the simulator reaches as localhost.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))
    return null;
  return url.origin;
}
