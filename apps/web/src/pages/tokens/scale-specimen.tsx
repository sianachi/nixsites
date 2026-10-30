import type { ReactElement } from 'react';

import { ELEVATION_STEPS, RADIUS_STEPS, SPACING_STEPS } from './specimens';

import { ScrollRegion, Card, Text, cn } from '@nix/ui';

/**
 * Spacing, radius and elevation specimens.
 *
 * Spacing bars are sized purely by width utilities, which Tailwind v4 derives
 * from the single --spacing token. The Industry sheet sets that base to a
 * 0.85 density unit, so every bar below is proof that the density made it
 * through the build: at the default 4px base the bars would be visibly wider.
 *
 * The radius row is a specimen of the tokens, not a licence to use them.
 * Cards, figures and buttons in this system stay square; the radius steps
 * exist for the few places the design system applies them.
 */

function SpacingScale(): ReactElement {
  return (
    <ScrollRegion className="min-w-0 overflow-x-auto" aria-label="Spacing scale">
      <dl className="flex min-w-max flex-col gap-2">
        {SPACING_STEPS.map((entry) => (
          <div key={entry.step} className="flex items-center gap-4">
            <Text as="dt" tone="muted" variant="bodySmall" className="w-20 shrink-0">
              {entry.step}
            </Text>
            <dd className="flex-1">
              <span aria-hidden="true" className={cn('block h-3 bg-accent-500', entry.className)} />
            </dd>
          </div>
        ))}
      </dl>
    </ScrollRegion>
  );
}

export function SpacingSpecimen(): ReactElement {
  return (
    <Card kicker="Foundations" title="Spacing">
      <Text tone="muted">
        Every gap, pad and inset in the app is a multiple of one spacing token. The bars step
        through that scale; their widths come from the token, not from a pixel value written here.
      </Text>
      <SpacingScale />
    </Card>
  );
}

export function ShapeSpecimen(): ReactElement {
  return (
    <Card kicker="Foundations" title="Radius and elevation">
      <Text tone="muted">
        Three radius steps and three elevation steps, all tuned to the light ground. Interface
        objects in Nix stay square-cornered; these are the tokens, shown for completeness.
      </Text>
      <div className="flex flex-col gap-4">
        <ul className="flex flex-wrap gap-4">
          {RADIUS_STEPS.map((step) => (
            <li key={step.token} className="flex flex-col items-start gap-1">
              <span
                aria-hidden="true"
                className={cn('block size-16 bg-accent-200 ring-1 ring-accent-500', step.className)}
              />
              <Text tone="muted" as="span" variant="bodySmall">
                {step.token}
              </Text>
            </li>
          ))}
        </ul>
        <ul className="flex flex-wrap gap-6">
          {ELEVATION_STEPS.map((step) => (
            <li key={step.token} className="flex flex-col items-start gap-2">
              <span
                aria-hidden="true"
                className={cn('block size-16 border border-divider bg-background', step.className)}
              />
              <Text tone="muted" as="span" variant="bodySmall">
                {step.token}
              </Text>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
