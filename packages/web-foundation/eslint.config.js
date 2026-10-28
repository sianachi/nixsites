// packages/web-foundation ESLint config: the repo-root flat config plus the two
// browser-side plugins the web app uses (react-hooks, jsx-a11y), so moved code
// is held to the same rules it had in apps/web.
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import rootConfig from '../../eslint.config.js';

export default tseslint.config(
  ...rootConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  { ...reactHooks.configs.flat['recommended-latest'], files: ['**/*.{ts,tsx}'] },
  { ...jsxA11y.flatConfigs.recommended, files: ['**/*.{ts,tsx}'] },
);
