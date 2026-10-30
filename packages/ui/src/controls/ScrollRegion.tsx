import { type ComponentPropsWithRef, type ReactNode } from 'react';

/**
 * <ScrollRegion> - a scrollable area a keyboard user can reach.
 *
 * Renders a labelled `region` with one tab stop, because an element that scrolls but cannot take
 * focus cannot be scrolled without a pointer. The lint rule cannot see that the element scrolls,
 * so the suppression lives here once instead of at every caller. The accessible name is required,
 * as either `aria-label` or `aria-labelledby`, since an unnamed region is not a landmark.
 *
 * Overflow, sizing and the focus ring stay with the caller's `className`.
 */
type RegionName =
  | { readonly 'aria-label': string; readonly 'aria-labelledby'?: undefined }
  | { readonly 'aria-labelledby': string; readonly 'aria-label'?: undefined };

export type ScrollRegionProps = Omit<
  ComponentPropsWithRef<'div'>,
  'role' | 'tabIndex' | 'aria-label' | 'aria-labelledby'
> &
  RegionName;

export function ScrollRegion(props: ScrollRegionProps): ReactNode {
  return (
    <div
      {...props}
      role="region"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
      tabIndex={0}
    />
  );
}
