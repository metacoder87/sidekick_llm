import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

// Three environments live in this repo and they do not share globals:
//   electron/*.cjs  — Node CommonJS, main process
//   src/**/*.jsx    — browser ESM, renderer (no Node access by design)
//   test/*.cjs      — Node CommonJS under the Electron ABI
// Linting them as one blob would either miss real undefined-variable bugs or
// drown in false ones, so each gets its own block.
export default [
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'build/icon.png'],
  },

  js.configs.recommended,

  // ---- Electron main process (CommonJS) ----
  {
    files: ['electron/**/*.cjs', 'build/**/*.cjs', '*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Caught unused params are idiomatic here (`catch (_error)`); allow the
      // underscore convention rather than forcing empty catch blocks.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },

  // ---- Renderer (React, ESM, browser) ----
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The renderer is deliberately untyped; prop-types would be noise without
      // catching anything the IPC boundary doesn't already validate.
      'react/prop-types': 'off',
      // An exhaustive-deps violation is a real stale-closure bug, not style —
      // this is the rule most likely to catch a genuine defect in this codebase.
      'react-hooks/exhaustive-deps': 'warn',
      // Apostrophes in user-facing prose are intentional and read fine; escaping
      // them makes the source worse. Keep the rule for `>` and `}`, which are
      // genuinely ambiguous in JSX and can silently swallow text.
      'react/no-unescaped-entities': ['error', { forbid: ['>', '}'] }],
      // The codebase's load-on-mount effects call an *async* loader, so setState
      // lands in a microtask, not synchronously — the rule can't see that. Kept as
      // a warning so a genuinely synchronous cascade still shows up.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // ---- Tests ----
  {
    files: ['test/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Prettier last: it turns off every rule that would fight the formatter.
  prettier,
];
