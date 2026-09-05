/**
 * Build the standalone BullMQ worker + scheduler entrypoints.
 *
 * The worker and scheduler run as separate processes from the
 * Next.js server (see `docker-compose.prod.yml` `worker` service).
 * The production image is dev-dependency-pruned, so it cannot run
 * the TypeScript sources directly via `tsx`. This script bundles
 * each entrypoint — with all its `src/` imports inlined — into a
 * single self-contained `.mjs` file under `dist/`. node_modules
 * stay external (resolved at runtime from the pruned production
 * `node_modules`), so every package the bundle imports MUST be a
 * production `dependency`, not a `devDependency`.
 *
 * Output: `dist/worker.mjs`, `dist/scheduler.mjs`.
 * Run:    `node scripts/build-worker.mjs`  (npm script: `build:worker`)
 */
import { build } from 'esbuild';

const common = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Keep every node_modules package external — resolved at runtime
    // from the production node_modules. Only first-party `src/` +
    // `scripts/` code is inlined into the bundle.
    packages: 'external',
    // Resolves the `@/*` and `@dub/*` path aliases.
    tsconfig: 'tsconfig.json',
    logLevel: 'info',
    // esbuild emits `import.meta` helpers etc. for ESM; banner keeps
    // CJS-style `require`/`__dirname` working for any external that
    // an inlined module reaches for.
    banner: {
        js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
};

await build({
    ...common,
    entryPoints: ['scripts/worker.ts'],
    outfile: 'dist/worker.mjs',
});
await build({
    ...common,
    entryPoints: ['scripts/scheduler.ts'],
    outfile: 'dist/scheduler.mjs',
});
// Self-assessment library seeder — run from the container entrypoint after
// `prisma migrate deploy` so the NIS2 gap + AI-gov question sets (global
// reference tables, not carried by migrations) self-heal on every deploy.
// The fixture JSON is inlined into the bundle at build time.
await build({
    ...common,
    entryPoints: ['scripts/seed-self-assessments.ts'],
    outfile: 'dist/seed-self-assessments.mjs',
});
// Global policy-template library seeder — run from the entrypoint after
// migrate deploy so the template library (ciso-toolkit + imported + IC-original
// gap-fill) self-heals on every deploy. Fixture JSON inlined at build time.
await build({
    ...common,
    entryPoints: ['scripts/seed-policy-templates.ts'],
    outfile: 'dist/seed-policy-templates.mjs',
});

await build({
    ...common,
    entryPoints: ['scripts/seed-control-template-tasks.ts'],
    outfile: 'dist/seed-control-template-tasks.mjs',
});

await build({
    ...common,
    entryPoints: ['scripts/seed-framework-catalogs.ts'],
    outfile: 'dist/seed-framework-catalogs.mjs',
});

await build({
    ...common,
    entryPoints: ['scripts/catalog-check.ts'],
    outfile: 'dist/catalog-check.mjs',
});
// Built-in vendor-assessment questionnaire seeder — run from the entrypoint
// after migrate deploy so the Supplier Due Diligence + Supplier Security
// Assessment templates (RLS-tenant-scoped, seeded per-tenant) self-heal on
// every deploy. Fixture JSON inlined at build time.
await build({
    ...common,
    entryPoints: ['scripts/seed-vendor-questionnaires.ts'],
    outfile: 'dist/seed-vendor-questionnaires.mjs',
});

console.log('✓ built dist/worker.mjs + dist/scheduler.mjs + dist/seed-self-assessments.mjs + dist/seed-policy-templates.mjs + dist/seed-vendor-questionnaires.mjs + dist/seed-control-template-tasks.mjs + dist/seed-framework-catalogs.mjs + dist/catalog-check.mjs');
