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
      // db/ instruments — outside this config's tsconfig, same as .mjs was.
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
  // Drill 07's stretch goal, static half: a query against tenant data has to go
  // through TenantDb, which cannot run one without a tenant context.
  //
  // What this is worth, honestly: it stops the accident, not the intent. One
  // `eslint-disable-next-line` defeats it, and it cannot see a query built in a
  // string somewhere else. The enforcement is the row-level security in
  // migration 003 — this only means you have to mean it. The schema half of the
  // check is `pnpm check:tenancy`.
  //
  // Exempt by design: `tenancy/` is the seam itself, `postgres/` owns the pool,
  // and `health/` and `info/` are genuinely tenant-free (SELECT 1, version()).
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
