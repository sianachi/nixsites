import { createBrowserService } from './browser.ts';
import { createBrowserServer } from './server.ts';

const binding = new URL('http://' + (process.env.NIX_BROWSER_LISTEN ?? '127.0.0.1:8313'));
if (
  !binding.port ||
  binding.pathname !== '/' ||
  binding.search ||
  binding.hash ||
  binding.username ||
  binding.password
) {
  throw new Error('NIX_BROWSER_LISTEN must be an address and port.');
}
const attachment = process.env.NIX_BROWSER_ATTACHMENT_ORIGIN;
if (attachment && new URL(attachment).origin !== attachment) {
  throw new Error('NIX_BROWSER_ATTACHMENT_ORIGIN must be an HTTP origin.');
}
const browser = createBrowserService(attachment ? { attachmentOrigin: attachment } : {});
const server = createBrowserServer({
  secret: process.env.NIX_BROWSER_INTERNAL_SECRET ?? '',
  browser,
});
server.listen(Number(binding.port), binding.hostname.replace(/^\[|\]$/g, ''));
process.once('SIGTERM', () => {
  server.close();
});
process.once('SIGINT', () => {
  server.close();
});
