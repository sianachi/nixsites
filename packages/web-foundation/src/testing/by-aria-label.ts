import { waitFor } from '@testing-library/react';

/**
 * The one element whose `aria-label` is exactly `label`, waited for like `findBy*`. Testing
 * Library's `findByLabelText` also resolves `<label>` and `aria-labelledby` associations by
 * visiting every element, which on a page this large costs more than the rest of the test; use
 * this when the label is an `aria-label`.
 */
export function findByAriaLabel(label: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[aria-label]')].filter(
      (element) => element.getAttribute('aria-label') === label,
    );
    const [only] = found;
    if (found.length !== 1 || only === undefined) {
      throw new Error(`Expected one element labelled "${label}", found ${String(found.length)}.`);
    }
    return only;
  });
}
