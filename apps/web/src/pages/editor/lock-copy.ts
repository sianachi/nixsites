import { formatTime } from '@nix/web-foundation/lib/date-format';
/** What a body is called in lock copy, by the kind that draws it. */
export function bodyNoun(bodyKind: string): string {
  switch (bodyKind) {
    case 'canvas':
      return 'canvas';
    case 'spreadsheet':
      return 'spreadsheet';
    case 'file':
      return 'file';
    default:
      return 'note';
  }
}

/** A clock time in the reader's own format, for when an unlock ends. */
export function clockTime(at: Date): string {
  return formatTime(at);
}
