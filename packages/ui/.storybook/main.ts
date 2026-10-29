import { type StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook is the component library's contract: every component ships
 * stories for all of its variants and all of its interaction states, and
 * @storybook/addon-a11y runs axe over each one.
 *
 * Vite configuration (the React plugin and @tailwindcss/vite) comes from the
 * package's own vite.config.ts, which Storybook's react-vite framework loads
 * and merges - the same config Vitest uses, so a story renders identically in
 * the browser and in a test.
 */
const config: StorybookConfig = {
  stories: [
    '../src/**/*.stories.@(ts|tsx)',
    '../../../apps/web/src/pets/*.stories.tsx',
    '../../../apps/web/src/shell/notifications/*.stories.tsx',
    '../../../apps/web/src/shell/*.stories.tsx',
    '../../../packages/web-editor/src/editor/*.stories.tsx',
    '../../../apps/web/src/items/*.stories.tsx',
    '../../../apps/web/src/graph/*.stories.tsx',
    '../../../apps/web/src/search/*.stories.tsx',
    '../../../packages/web-editor/src/plugins/*.stories.tsx',
    '../../../apps/web/src/pages/*.stories.tsx',
    '../../../apps/web/src/files/*.stories.tsx',
    '../../../apps/web/src/templates/*.stories.tsx',
    '../../../apps/web/src/views/chart/*.stories.tsx',
    '../../../apps/web/src/views/core/*.stories.tsx',
    '../../../apps/web/src/pets/chat/*.stories.tsx',
    '../../../apps/web/src/views/calendar/*.stories.tsx',
    '../../../apps/web/src/views/sheet/*.stories.tsx',
    '../../../apps/web/src/views/spreadsheet/*.stories.tsx',
    '../../../apps/web/src/views/form/*.stories.tsx',
    '../../../apps/web/src/views/finance/*.stories.tsx',
    '../../../apps/web/src/views/habit-tracker/*.stories.tsx',
    '../../../apps/web/src/views/list/*.stories.tsx',
    '../../../apps/web/src/views/board/*.stories.tsx',
    '../../../apps/web/src/views/gallery/*.stories.tsx',
    '../../../apps/web/src/views/drive/*.stories.tsx',
    '../../../apps/web/src/views/wizard/*.stories.tsx',
    '../../../apps/web/src/views/checklist/*.stories.tsx',
    '../../../apps/web/src/views/matrix/*.stories.tsx',
    '../../../apps/web/src/views/outline/*.stories.tsx',
    '../../../apps/web/src/views/query/*.stories.tsx',
    '../../../apps/web/src/views/suggest/*.stories.tsx',
    '../../../apps/web/src/collections/properties/*.stories.tsx',
    '../../../apps/web/src/automations/*.stories.tsx',
    '../../../packages/web-workspaces/src/launch/*.stories.tsx',
    '../../../apps/web/src/recording/*.stories.tsx',
    '../../../apps/web/src/speech/*.stories.tsx',
    '../../../packages/web-sites/src/sites/*.stories.tsx',
  ],
  staticDirs: [
    { from: '../../../apps/web/public/pets', to: '/pets' },
    {
      from: '../../../apps/web/node_modules/@excalidraw/excalidraw/dist/prod/fonts',
      to: '/excalidraw-assets/fonts',
    },
  ],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs', '@storybook/addon-vitest'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
};

export default config;
