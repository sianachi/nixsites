import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * <Avatar> - a person, as the initials of their name in a small square.
 *
 * Square and hairline like `<Tag>`, not a filled circle: the chrome is type-led, and a row of
 * coloured discs would be the loudest thing on a board whose point is the work, not the people.
 * No pictures - Nix holds no profile images - and no colour hashed from the name, which would put
 * a decorative palette on screen that means nothing.
 *
 * The initials are decoration; the name is the content. So the square is hidden from assistive
 * technology unless `labelled` is set, for the one case where it stands alone with nothing beside
 * it saying who it is.
 */

const avatarVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center rounded-sm border border-divider font-heading uppercase tracking-wider text-foreground/80',
  {
    variants: {
      size: {
        sm: 'size-6 text-xs',
        md: 'size-8 text-sm',
      },
    },
    defaultVariants: { size: 'sm' },
  },
);

type AvatarSize = 'sm' | 'md';

export interface AvatarProps {
  readonly name: string;
  readonly size?: AvatarSize;
  /** Names the square for assistive technology, when no visible name sits beside it. */
  readonly labelled?: boolean;
  readonly className?: string;
}

/** Up to two initials: the first letters of the first and last words. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`;
}

export function Avatar(props: AvatarProps): ReactNode {
  const { name, size = 'sm', labelled = false, className } = props;

  return (
    <span
      className={cn(avatarVariants({ size }), className)}
      {...(labelled ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true })}
    >
      {initialsOf(name)}
    </span>
  );
}
