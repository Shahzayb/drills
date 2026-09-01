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
  //
  // `ingest/api-key.guard.ts` is the fourth, and it is exempt for a different
  // reason than the other three. It is not tenant-free because it avoids tenant
  // data — it reads `api_keys`, which carries org_id and has a policy like every
  // other scoped table. It is exempt because it is the code that DECIDES the
  // tenant, and so cannot run inside the scope it establishes: with app.org_id
  // unset the policy admits no rows and the lookup finds nothing. It goes
  // through `app_org_for_api_key()`, a SECURITY DEFINER function that returns a
  // bigint and grants no SELECT on the table. One file, named individually
  // rather than the whole directory, so `ingest/` gaining a second file does not
  // silently gain the exemption too.
  // See plans/2026-08-31_drill-12-idempotent-ingest.md.
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/tenancy/**',
      'src/postgres/**',
      'src/health/**',
      'src/info/**',
      'src/ingest/api-key.guard.ts',
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
