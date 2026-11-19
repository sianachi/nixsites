import { BrowserFault } from './contracts.ts';

const credential =
  /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:gh[pousr]_|github_pat_|lin_api_|glpat-|sk-(?:ant-|proj-|svcacct-)?|xox[baprs]-)[a-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}\b|\bbearer\s+[a-z0-9_.~+/=-]{16,}|\b(?:api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|password)["']?\s*[:=]\s*["']?[a-z0-9_.~+/=-]{12,})/i;
const credentialField = /(?:apikey|clientsecret|accesstoken|refreshtoken|password|privatekey)$/i;

export function checkEgress(value: string, field = ''): void {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Non-URL text can contain a literal percent character.
  }
  if (
    (value.length > 0 && credentialField.test(field.replaceAll(/[^a-z]/gi, ''))) ||
    credential.test(value) ||
    credential.test(decoded)
  ) {
    throw new BrowserFault('website_egress_blocked');
  }
}

export function checkAttachment(bytes: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BrowserFault('attachment_egress_blocked');
  }
  if (/\p{Cc}/u.test(text.replaceAll(/[\n\r\t]/g, '')) || text.startsWith('%PDF-')) {
    throw new BrowserFault('attachment_egress_blocked');
  }
  checkEgress(text);
}
