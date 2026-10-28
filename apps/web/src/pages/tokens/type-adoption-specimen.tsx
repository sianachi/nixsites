import type { ReactElement } from 'react';

import { Blueprint, Card, Text, fieldLabel } from '@nix/ui';

/**
 * The type adoption specimen: who owns the type scale, and where it is still owned locally.
 *
 * `TypeSpecimen` (`type-specimen.tsx`) proves the token sheet reaches the compiled CSS - five
 * lines, five steps, the pairing visibly intact. It cannot show what U11's sweep found, because
 * every line in it already goes through `<Text>`: nothing there can be doing it the other way.
 * What the sweep actually found was fifty-five text elements across `apps/web` dressing themselves
 * - `<p className="text-sm text-muted">Loading…</p>` and forty-odd of its cousins - each one made
 * of real tokens, correctly chosen, and none of them asking the primitive for anything.
 *
 * The cost of that is not that any one line looked wrong. It is that `--text-sm` was published by
 * the sheet, used about twenty times for one purpose, and named by no variant - so the step that
 * the interface talks about itself in existed everywhere and belonged to nobody. Naming it
 * (`note`) was possible only once the twenty sites were in one list.
 *
 * So this specimen has three parts, in the order a reviewer needs them:
 *
 *   - **The variant scale, doing its job.** Not "h1 through kicker" as labels, but the sentence
 *     each variant actually carries in the product. A scale is only legible as the set of
 *     decisions it settles, and "which of these two is a caption and which is a note" is a
 *     question the sizes alone do not answer.
 *   - **The tracking scale.** Five steps that arrived after `<Text>` did, which is why the
 *     primitive's own note about them was stale for a whole phase. They are shown at the sizes
 *     that ask for them, because the amount of air capitals need is a function of size and the
 *     ladder is unreadable at one size.
 *   - **The allowlist.** Every place a raw type class deliberately remains, and the reason.
 *     `scripts/check-text-primitive.sh` enforces the rule; this is where the exceptions are
 *     written down in prose, because a list of exceptions that lives only in a script is a list
 *     nobody reads until it fails them.
 */

interface VariantRow {
  readonly variant: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'body' | 'bodySmall' | 'note' | 'caption';
  /** What this variant is for, said as the job rather than as the size. */
  readonly job: string;
  /** A line the product really renders at this variant. */
  readonly sample: string;
}

const VARIANT_ROWS: readonly VariantRow[] = [
  { variant: 'h1', job: 'The page names itself', sample: 'Industry design tokens' },
  { variant: 'h2', job: 'A section of a page', sample: 'Recent workspaces' },
  {
    variant: 'h3',
    job: 'A panel heading, and the top of an empty state',
    sample: 'Nothing here yet',
  },
  { variant: 'h4', job: 'A heading inside a panel', sample: 'Fields on this item' },
  {
    variant: 'h5',
    job: 'An item title in chrome - the header, a card',
    sample: 'Quarterly review',
  },
  {
    variant: 'body',
    job: 'Prose somebody sits and reads',
    sample:
      'A view is a way of looking at this item. Everybody who can see it sees the same views.',
  },
  {
    variant: 'bodySmall',
    job: 'The same prose inside a panel, where the measure is short',
    sample: 'Everything inside this item can carry these properties.',
  },
  {
    variant: 'note',
    job: 'The interface talking about itself: a hint, a refusal, a loading line',
    sample: 'Searchable once indexing finishes. Downloadable now.',
  },
  {
    variant: 'caption',
    job: 'Metadata about content, not content',
    sample: 'Edited 4 minutes ago by Ada',
  },
];

/**
 * `h6` and `kicker` are absent above and shown here instead, because both are caps treatments and
 * the point of the pair is that they are the same idea at two sizes - which a table sorted by
 * size separates rather than shows.
 */
function CapsScale(): ReactElement {
  return (
    <Blueprint className="flex flex-col gap-3 p-4">
      <Text variant="h6" as="p">
        Heading six, the caps section label
      </Text>
      <Text variant="kicker" as="p">
        Kicker, the same idea two steps down
      </Text>
      <Text variant="bodySmall" tone="muted">
        Both are the heading face, set in capitals, tracked open. They differ in size and therefore
        in how much air the capitals get back - `wider` at 13px, `widest` at 10px - which is the
        tracking scale&rsquo;s whole argument in one pair.
      </Text>
    </Blueprint>
  );
}

interface TrackingRow {
  readonly token: string;
  /**
   * The literal utility classes under test, written out in full and never assembled from a
   * template string: Tailwind v4 finds classes by scanning source text, so a computed
   * `tracking-${step}` compiles to nothing at all. `specimens.ts` records the same constraint.
   */
  readonly className: string;
  readonly why: string;
  readonly sample: string;
}

const TRACKING_ROWS: readonly TrackingRow[] = [
  {
    token: 'tracking-tight',
    className: 'font-heading text-2xl font-semibold tracking-tight',
    why: 'Nunito Sans sets its display sizes a touch loose. Only the headings pull back.',
    sample: 'Quarterly review',
  },
  {
    token: 'tracking-slight',
    className: 'font-heading text-2xl font-semibold tracking-slight',
    why: 'Mixed case opened just enough to separate at heading weight. The login wordmark, and nothing else.',
    sample: 'NX',
  },
  {
    token: 'tracking-wide',
    className: 'font-heading text-md uppercase tracking-wide',
    why: 'Capitals at 15px. The larger the caps, the less air they need back.',
    sample: 'Section title',
  },
  {
    token: 'tracking-wider',
    className: 'font-heading text-xs uppercase tracking-wider text-muted',
    why: 'The standard caps label, at 11px. This exact string is published as `fieldLabel`.',
    sample: 'Organisation',
  },
  {
    token: 'tracking-widest',
    className: 'font-body text-2xs uppercase tracking-widest text-muted',
    why: 'At 10px capitals look set solid without it. This is the `kicker` variant.',
    sample: 'Contract',
  },
];

interface AllowlistRow {
  readonly where: string;
  readonly what: string;
  readonly why: string;
}

/**
 * The recorded allowlist: raw type classes that are correct where they are.
 *
 * The guard's exemption marker (`text-primitive-exempt`) points here. Anything not on this list is
 * either migrated or a defect, and a sixth entry appearing without a paragraph explaining itself is
 * the thing this table exists to make visible.
 */
const ALLOWLIST: readonly AllowlistRow[] = [
  {
    where: 'packages/ui control internals',
    what: '`Text.tsx` itself, `Field`’s label, the option rows in `Tabs`, `Segmented` and `Listbox`',
    why: 'The primitive cannot import itself, and a label carrying `htmlFor` has to be a real `<label>`. Those internals publish their type outward instead - through `<Text>` and through `fieldLabel` - which is why the guard scans `apps/web` and not this package.',
  },
  {
    where: 'packages/web-editor/src/editor/prose.ts',
    what: 'Every block and mark in a document',
    why: 'ProseMirror owns the document’s DOM, so React never sees a heading to wrap. The steps are named once in `prose-type.ts` and composed from there, and `prose.test.ts` holds the toggle summaries to the heading ranks they present as.',
  },
  {
    where: 'Elements that are not text',
    what: '`<button>`, `<input>`, `<kbd>`, `<th>`, `<output>`, `<legend>`, `<label>`',
    why: 'A control’s own box carries its own type; wrapping it to reach a variant would break the wiring that makes it a control. Where the treatment is the caps label, it comes from `fieldLabel` rather than from six copies of the same string.',
  },
  {
    where: 'Wordmarks and monograms',
    what: '`NX` on the login screen, `Nix` in the drawn title bar, a workspace’s initials chip',
    why: 'Lettering, not text: a fixed box whose type is part of the drawn mark. The login wordmark is the h2 step at `tracking-slight`, which is a tracking `<Text>` deliberately does not offer as a prop.',
  },
  {
    where: 'Display caps',
    what: '“Sign-in failed” on the callback screen, the item title field',
    why: 'The heading family at a heading size with no heading weight, set in capitals. `<Text variant="h3">` is the right size and the wrong weight, tracking and case; three call sites do not earn an uppercase display variant.',
  },
  {
    where: 'Weight without a variant',
    what: 'A recent workspace’s name, `text-base font-medium`',
    why: '`<Text>` has no weight axis - a variant fixes weight, which is what keeps the scale a scale. This row picks its name out from the timestamp under it by weight alone.',
  },
  {
    where: 'A specimen quoting another surface',
    what: 'The view switcher’s tabs in `rhythm-specimen.tsx`',
    why: 'Reproduced verbatim from `view-switcher.tsx`. A specimen that redrew the thing it is quoting would stop being evidence about the real surface.',
  },
  {
    where: 'One caps label off the published step',
    what: '`theme-choice.tsx`’s “Appearance”, at `text-2xs`',
    why: 'Everything about it is `fieldLabel` except the size. It names a group inside a 240px menu, where the published step sits level with the options under it and stops reading as their heading.',
  },
];

function VariantTable(): ReactElement {
  return (
    <Blueprint className="flex flex-col divide-y divide-divider">
      {VARIANT_ROWS.map((row) => (
        <div key={row.variant} className="flex flex-col gap-1 p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={fieldLabel}>{row.variant}</span>
            <Text variant="caption" as="span" tone="muted">
              {row.job}
            </Text>
          </div>
          <Text variant={row.variant} as="p">
            {row.sample}
          </Text>
        </div>
      ))}
    </Blueprint>
  );
}

function TrackingTable(): ReactElement {
  return (
    <Blueprint className="flex flex-col divide-y divide-divider">
      {TRACKING_ROWS.map((row) => (
        <div key={row.token} className="flex flex-col gap-1 p-4">
          <span className={fieldLabel}>{row.token}</span>
          {/* The class string is the specimen, so it goes on a plain element: routing it through
              `<Text>` would prove the primitive works and say nothing about the token. */}
          <div className={row.className}>{row.sample}</div>
          <Text variant="caption" as="p" tone="muted">
            {row.why}
          </Text>
        </div>
      ))}
    </Blueprint>
  );
}

function AllowlistTable(): ReactElement {
  return (
    <Blueprint className="flex flex-col divide-y divide-divider">
      {ALLOWLIST.map((row) => (
        <div key={row.where} className="flex flex-col gap-1 p-4">
          <Text variant="h6" as="h4">
            {row.where}
          </Text>
          <Text variant="note" as="p">
            {row.what}
          </Text>
          <Text variant="note" as="p" tone="muted">
            {row.why}
          </Text>
        </div>
      ))}
    </Blueprint>
  );
}

export function TypeAdoptionSpecimen(): ReactElement {
  return (
    <Card kicker="Patterns" title="Type adoption">
      <Text tone="muted">
        Every line of the first two tables below is drawn the way the product draws it: the variant
        table through <code>&lt;Text&gt;</code>, the tracking table through the literal utility
        classes the token sheet publishes. The third table is the part a specimen usually leaves out
        - where the rule does not apply, and why - because that is the list a reviewer needs when a
        guard stops them.
      </Text>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Text variant="kicker">The variant scale, by job</Text>
          <VariantTable />
          <CapsScale />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Text variant="kicker">The tracking scale</Text>
          <TrackingTable />
          <Text variant="bodySmall" tone="muted">
            The scale arrived after the typography primitive did, and the primitive&rsquo;s own note
            went on saying the sheet carried no tracking scale for a whole phase afterwards. That is
            the failure mode a specimen catches and a comment does not: a page that renders the five
            steps is a page somebody notices is missing one.
          </Text>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Text variant="kicker">Where a raw class stays, and why</Text>
        <AllowlistTable />
      </div>
    </Card>
  );
}
