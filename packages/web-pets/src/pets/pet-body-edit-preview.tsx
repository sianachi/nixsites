import { Text, cn, focusRing } from '@nix/ui';
import { useEffect, useRef, type ReactElement } from 'react';
import type { PreviewBodyEdit } from '@nix/structure-spec';
import { lineSegments, rangeSegments, type DiffSegment } from '@nix/web-foundation/lib/text-diff';

const COPY = {
  pending: {
    intro: 'The edited part of the note, before and after',
    before: 'Text now',
    after: 'Text after this change',
  },
  applied: {
    intro: 'The edited part of the note, before and after this change',
    before: 'Text before',
    after: 'Text after',
  },
} as const;

/** One side of the comparison: a label in words, and the full text in a focusable plain-text
 * scroll region whose changed runs are marked as removed or added in text as well as style. The
 * region scrolls to just above its first change when it appears, so a long section opens on the
 * edit with a little context. */
function TextSide({
  label,
  name,
  segments,
  kind,
}: {
  readonly label: string;
  readonly name: string;
  readonly segments: readonly DiffSegment[];
  readonly kind: 'removed' | 'added';
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const region = box.current;
    const first = region?.querySelector('[data-change]');
    if (!region || !(first instanceof HTMLElement)) return;
    // Two lines of context above the first change, so it does not open flush against the top.
    const lineHeight = Number.parseFloat(getComputedStyle(first).lineHeight);
    const context = 2 * (Number.isFinite(lineHeight) ? lineHeight : 20);
    region.scrollTop = Math.max(0, first.offsetTop - context);
  }, []);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Text variant="note" tone="muted">
        {label}
      </Text>
      <div
        ref={box}
        role="region"
        aria-label={name}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
        tabIndex={0}
        className={cn(
          'relative max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-sm border border-divider p-2',
          focusRing,
        )}
      >
        <Text variant="note">
          {segments.map((segment, index) =>
            !segment.changed ? (
              <span key={index}>{segment.text}</span>
            ) : kind === 'removed' ? (
              <del key={index} data-change="" className="text-muted line-through">
                <Text as="span" variant="note" className="sr-only">
                  removed:{' '}
                </Text>
                {segment.text}
              </del>
            ) : (
              <ins key={index} data-change="" className="bg-accent/10 underline">
                <Text as="span" variant="note" className="sr-only">
                  added:{' '}
                </Text>
                {segment.text}
              </ins>
            ),
          )}
        </Text>
      </div>
    </div>
  );
}

/** The text a section or passage edit replaces and the text it leaves, side by side when the
 * panel is wide enough and stacked when it is not. Both sides are plain text: the model chose
 * the new one, so it is never rendered as Markdown. A passage marks the characters that change;
 * a section marks the lines that differ. `phase` is `applied` on a receipt, once the edit ran. */
export function PetBodyEditPreview({
  edit,
  phase = 'pending',
}: {
  readonly edit: PreviewBodyEdit;
  readonly phase?: 'pending' | 'applied';
}): ReactElement {
  const copy = COPY[phase];
  const marked =
    edit.beforeRange && edit.afterRange
      ? {
          before: rangeSegments(edit.before, edit.beforeRange),
          after: rangeSegments(edit.after, edit.afterRange),
        }
      : lineSegments(edit.before, edit.after);
  return (
    <div className="@container flex flex-col gap-2">
      <Text variant="note" tone="muted">
        {copy.intro}
      </Text>
      <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
        <TextSide
          label={copy.before}
          name={`${copy.before}, ${edit.subject}`}
          segments={marked.before}
          kind="removed"
        />
        {edit.after ? (
          <TextSide
            label={copy.after}
            name={`${copy.after}, ${edit.subject}`}
            segments={marked.after}
            kind="added"
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-1">
            <Text variant="note" tone="muted">
              {copy.after}
            </Text>
            <Text variant="note" tone="muted">
              Nothing replaces it: this text is removed.
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
