// Root ESLint flat config. Workspace packages extend this and add
// environment-specific plugins (react-hooks, jsx-a11y) in their own configs.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.tsbuild/**',
      '**/build/**',
      '**/coverage/**',
      '**/storybook-static/**',
      // Byte-exact site renderer output, compared by golden tests; not source.
      '**/__golden__/**',
      '**/node_modules/**',
      // Written by `openapi-typescript` from the committed Core contract. Restyling it would be
      // undone by the next `pnpm --filter @nix/api-client generate`, and the file is not ours to
      // have opinions about - the schemas that wrap it are.
      '**/src/generated/**',
      'backend/**',
      'deploy/**',
      'Design language for Nix review/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
