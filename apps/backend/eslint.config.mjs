// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'migrations/*.js',
      'dist/**/*.js',
      '**.mjs',
      '**/*.mjs',
      '**/*.mts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/tenancy/**',
      'src/postgres/**',
      'src/health/**',
      'src/info/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/postgres/postgres.service'],
              message:
                'Use TenantDb.withOrg() from src/tenancy — a query against ' +
                'tenant data must carry a tenant context. If this file is ' +
                'genuinely tenant-free, add it to the ignores in ' +
                'eslint.config.mjs and say why.',
            },
          ],
        },
      ],
    },
  },
);
