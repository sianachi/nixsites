import { type Decorator, type Preview } from '@storybook/react-vite';
import { createElement } from 'react';

import { initializeExcalidrawAssets } from '../../web-foundation/src/lib/excalidraw-assets';

// The product typeface, self-hosted (no font CDN, ever) - the same weights
// apps/web imports in its Tailwind entry, so stories render in the letterforms
// the product ships.
import '@fontsource/nunito-sans/400.css';
import '@fontsource/nunito-sans/600.css';
import '@fontsource/nunito-sans/700.css';

import './tailwind.css';

initializeExcalidrawAssets();

// Match the application's touch-editing type floor, including portal content.
document.body.classList.add(
  '[@media(any-pointer:coarse)]:[&_:is(input,textarea,select,[contenteditable=true])]:[--text-2xs:var(--text-lg)]',
  '[@media(any-pointer:coarse)]:[&_:is(input,textarea,select,[contenteditable=true])]:[--text-xs:var(--text-lg)]',
  '[@media(any-pointer:coarse)]:[&_:is(input,textarea,select,[contenteditable=true])]:[--text-sm:var(--text-lg)]',
  '[@media(any-pointer:coarse)]:[&_:is(input,textarea,select,[contenteditable=true])]:[--text-base:var(--text-lg)]',
  '[@media(any-pointer:coarse)]:[&_:is(input,textarea,select,[contenteditable=true])]:[--text-md:var(--text-lg)]',
);

/**
 * `a11y.test: 'error'` makes an axe finding fail the story under the Vitest
 * addon, so an inaccessible component cannot merge green. Backgrounds are
 * disabled because the ground is not a decoration a story picks: it is
 * `--color-bg`, set on the body by the Tailwind entry, and the `ground` global
 * below is the only thing that moves it.
 *
 * The token sheet describes two grounds (ADR-0008), and the contrast reasoning
 * recorded across the library was derived against the light one. So the ground
 * is a global with a toolbar switch, and a story that wants the dark one says
 * `globals: { ground: 'dark' }` - which is what puts axe on both grounds.
 */

/** The two grounds the token sheet defines. */
type Ground = 'light' | 'dark';

/**
 * The ground is chosen by writing `data-theme` on the document element, which
 * is the switch the token sheet is built around: `:root[data-theme]` reassigns
 * the semantic roles and outranks `prefers-color-scheme`, so a headless browser
 * reporting a light system preference still renders the dark ground faithfully.
 *
 * It has to be the document element and not a wrapper: the sheet's selector is
 * `:root[data-theme='dark']`, and the page's own background comes from the
 * Tailwind entry's `body` rule, so a nested wrapper would tint the story and
 * leave the page behind it on the other ground - which is exactly the mismatch
 * an axe contrast check would then measure. Every story sets the attribute,
 * light included, so a dark story cannot leak into the one after it.
 */
const withGround: Decorator = (Story, context) => {
  const ground: Ground = context.globals.ground === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = ground;

  return createElement(Story);
};

const preview: Preview = {
  // The stories under apps/web draw views, which look their kind up in the app's registry. Loaded
  // here rather than imported above, so the view modules evaluate after the Excalidraw asset path.
  // The test runner calls this once per story file over one module graph, so it registers once.
  beforeAll: async () => {
    const { VIEW_KINDS } = await import('../../../packages/web-views/src/core/view-kinds');
    if (VIEW_KINDS.length === 0) {
      (await import('../../web-pets/src/register-views')).registerViews();
    }
  },
  initialGlobals: { ground: 'light' satisfies Ground },
  globalTypes: {
    ground: {
      description: 'The ground the story is drawn on',
      toolbar: {
        title: 'Ground',
        icon: 'mirror',
        items: [
          { value: 'light' satisfies Ground, title: 'Light' },
          { value: 'dark' satisfies Ground, title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withGround],
  parameters: {
    layout: 'centered',
    a11y: { test: 'error' },
    backgrounds: { disable: true },
    controls: { expanded: true, matchers: { color: /(background|color)$/i } },
  },
};

export default preview;
