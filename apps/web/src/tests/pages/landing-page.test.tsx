import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LandingPage } from '../../pages/landing-page';

const downloads = vi.hoisted(() => ({
  iOS: null as string | null,
  Android: null,
  macOS: null,
  Windows: null,
  Linux: null,
}));
vi.mock('../../pages/landing-apps', async (original) => ({
  ...(await original()),
  APP_DOWNLOADS: downloads,
}));

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
  downloads.iOS = null;
});

describe('the landing page tour', () => {
  it('offers the desktop and the phone video, neither loading nor playing until asked', () => {
    const { container } = render(<LandingPage onSignIn={() => undefined} demo />);

    const videos = [...container.querySelectorAll('video')];
    expect(videos.map((video) => video.getAttribute('src'))).toEqual([
      '/landing/brag.mp4',
      '/landing/brag-phone.mp4',
    ]);
    for (const video of videos) {
      expect(video.getAttribute('preload')).toBe('none');
      expect(video.autoplay).toBe(false);
      expect(video.controls).toBe(true);
      expect(video.getAttribute('aria-label')).toMatch(/tour/u);
    }
  });
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
      'Smart list',
      'Drive',
      'Interactive form',
      'Custom view',
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

describe('the landing page apps section', () => {
  it('shows a disabled Coming soon button for every app without a link', () => {
    render(<LandingPage onSignIn={() => undefined} demo />);

    const section = document.getElementById('apps');
    expect(section).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Apps' })).toHaveAttribute('href', '#apps');
    for (const platform of ['iOS', 'Android', 'macOS', 'Windows', 'Linux']) {
      const button = screen.getByRole('button', { name: `${platform} app: coming soon` });
      expect(button).toBeDisabled();
      expect(section).toContainElement(button);
    }
    expect(screen.queryByRole('link', { name: /Download for/ })).toBeNull();
  });

  it('links a configured app and leaves the others coming soon', () => {
    downloads.iOS = 'https://example.com/nix.ipa';
    render(<LandingPage onSignIn={() => undefined} demo />);

    expect(screen.getByRole('link', { name: 'Download for iOS' })).toHaveAttribute(
      'href',
      'https://example.com/nix.ipa',
    );
    expect(screen.queryByRole('button', { name: 'iOS app: coming soon' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Android app: coming soon' })).toBeDisabled();
  });
});
