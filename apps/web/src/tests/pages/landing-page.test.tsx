import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LandingPage } from '../../pages/landing-page';

const picture = (): string | null =>
  screen.getByRole('tabpanel').querySelector('img')?.getAttribute('src') ?? null;

let deviceAppearance: EventTarget & { matches: boolean };

beforeEach(() => {
  deviceAppearance = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', () => deviceAppearance);
});

function setDarkAppearance(matches: boolean): void {
  act(() => {
    deviceAppearance.matches = matches;
    deviceAppearance.dispatchEvent(Object.assign(new Event('change'), { matches }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

/** The hero opens on Homebase and steps through every view, by pointer or by arrow keys. */
describe('the landing page view gallery', () => {
  it('lists every view, Homebase first', () => {
    render(<LandingPage onSignIn={() => undefined} demo />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Homebase',
      'Notes',
      'Search',
      'Graph',
      'Board',
      'List',
      'Calendar',
      'Timeline',
      'Spreadsheet',
      'Gallery',
      'Checklist',
      'Matrix',
      'Outline',
      'Chart',
      'Form',
      'Habit tracker',
      'Companion',
      'Artifact',
    ]);
  });

  it('opens on Homebase and moves between views', async () => {
    const user = userEvent.setup();
    render(<LandingPage onSignIn={() => undefined} demo />);

    expect(screen.getByRole('tab', { name: 'Homebase' })).toHaveAttribute('aria-selected', 'true');
    expect(picture()).toBe('/landing/homebase.jpg');

    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(picture()).toBe('/landing/timeline.jpg');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Spreadsheet' })).toHaveFocus();
    expect(picture()).toBe('/landing/sheet.jpg');

    await user.keyboard('{End}');
    expect(picture()).toBe('/landing/artifact.jpg');
    await user.keyboard('{ArrowRight}');
    expect(picture()).toBe('/landing/homebase.jpg');
  });

  it('follows the device appearance until a mode is applied', async () => {
    const user = userEvent.setup();
    render(<LandingPage onSignIn={() => undefined} demo />);
    expect(picture()).toBe('/landing/homebase.jpg');

    setDarkAppearance(true);
    expect(picture()).toBe('/landing/homebase-dark.jpg');
    // Pictures further down the page follow too, and only the shown variant is in the page.
    expect(document.querySelectorAll('img[src$="-dark.jpg"]').length).toBe(
      document.querySelectorAll('img').length,
    );

    await user.click(screen.getByRole('tab', { name: 'Graph' }));
    expect(picture()).toBe('/landing/graph-dark.jpg');

    setDarkAppearance(false);
    expect(picture()).toBe('/landing/graph.jpg');
    expect(document.querySelectorAll('img[src$="-dark.jpg"]')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Theme' }));
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(picture()).toBe('/landing/graph.jpg');
    await user.click(screen.getByRole('button', { name: 'Apply theme' }));
    expect(picture()).toBe('/landing/graph-dark.jpg');
  });
});
