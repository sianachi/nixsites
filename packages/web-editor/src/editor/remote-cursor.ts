import { initialsOf } from './presence-list';

/**
 * Another person's caret in the note: a thin line in their cursor colour with a small initials
 * circle floating above it. Both are positioned out of the text flow, so a collaborator never
 * pushes words onto the next line, which y-prosemirror's default name block did.
 */
export function remoteCursor(user: {
  readonly name?: unknown;
  readonly color?: unknown;
}): HTMLElement {
  const name = typeof user.name === 'string' && user.name.trim() !== '' ? user.name : 'Someone';
  const color = typeof user.color === 'string' ? user.color : 'var(--color-accent)';

  const caret = document.createElement('span');
  caret.className = 'pointer-events-none relative -mx-px border-l-2 select-none';
  caret.style.borderColor = color;
  caret.title = name;

  const profile = document.createElement('span');
  profile.className =
    'absolute bottom-full left-0 mb-0.5 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border bg-surface text-xs leading-none text-muted';
  profile.style.borderColor = color;
  profile.textContent = initialsOf(name);
  // The header's presence list already names who is here; the caret is not read out twice.
  profile.setAttribute('aria-hidden', 'true');

  // Word joiners, as y-prosemirror's own caret has: they give the line its height without
  // allowing a break on either side of it.
  caret.append('\u2060', profile, '\u2060');
  return caret;
}
