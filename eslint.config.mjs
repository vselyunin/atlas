import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typescript = ['**/*.{ts,tsx,mts,cts}'];

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.atlas/**',
      '**/.superpowers/**',
      '**/.agents/**',
      '**/.codex/**',
      '**/.aws/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.vite/**',
      '**/worker-journal/**',
      '**/mockServiceWorker.js',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  {
    files: typescript,
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}', 'apps/{api,worker}/**/*.{ts,mts,cts}', 'apps/board/*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/board/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
);
