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
    // ═══ THE CJS SHIMS ESM DOES NOT HAVE ═══
    //
    // esbuild emits `import.meta` helpers for ESM, but `require`, `__filename`
    // and `__dirname` simply do not exist there. This banner supplies all
    // three, for any inlined module that reaches for them.
    //
    // It used to supply only `require`, while this comment claimed it supplied
    // `__dirname` too — so a reader checking whether `__dirname` was safe in
    // worker-reachable code found a comment saying yes. It was not:
    // `dist/worker.mjs` USED it once and DEFINED it zero times (#3611), and
    // the one use is at module scope, so importing that module threw a
    // ReferenceError and took every export in it with it.
    //
    // What that cost: `legacy-reconcile` adjudicates behind a try/catch whose
    // comment explains that adjudication must never fail a completed run —
    // correct, and exactly what turned this into a `warn` line nobody chased.
    // Every RESOLVED reconcile logged "adjudication failed, run stands" with
    // `__dirname is not defined`, for the life of the ESM bundle.
    //
    // ═══ WHAT `__dirname` RESOLVES TO HERE, WHICH IS NOT WHAT IT LOOKS LIKE ═══
    //
    // The BUNDLE's directory — `dist/` — not the source module's. That is the
    // right answer for `require` and the wrong one for anything resolving a
    // path relative to its own source file. The only such caller today is
    // `EVALUATION_DIR` in `ai/identity-match/evaluation-record.ts`, whose
    // `evaluations/` directory sits beside the SOURCE and is not copied into
    // `dist`. So the import now succeeds and `listEvaluationRecordFiles()`
    // returns `[]` from a directory that does not exist, which it already
    // handles explicitly.
    //
    // That is a deliberate choice rather than an oversight, and it is written
    // down at the other end too: the worker does not read evaluation records.
    // The canary check that consumes them runs in CI, from source, where
    // `__dirname` is the source directory. Making the worker able to read them
    // would mean copying `evaluations/` into `dist` and keeping that in step,
    // for a consumer that does not exist.
    banner: {
        js:
            "import { createRequire as __createRequire } from 'module';"
            + "import { dirname as __nodeDirname } from 'path';"
            + "import { fileURLToPath as __nodeFileURLToPath } from 'url';"
            + "const require = __createRequire(import.meta.url);"
            + "const __filename = __nodeFileURLToPath(import.meta.url);"
            + "const __dirname = __nodeDirname(__filename);",
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
// Container healthcheck for the `worker` service (#2745). Bundled rather than
// run from source because the runner image carries no source tree, and
// `docker-compose.prod.yml` invokes it as `node dist/worker-healthcheck.mjs`.
// If this entry is removed the compose healthcheck silently fails every probe
// and the container is marked unhealthy forever — `worker-heartbeat-wiring`
// pins the pair.
await build({
    ...common,
    entryPoints: ['scripts/worker-healthcheck.ts'],
    outfile: 'dist/worker-healthcheck.mjs',
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

// Library + mapping-set sync — runs from the entrypoint after the catalogue
// seed. Unlike the seeders above it inlines app code (the library importer and
// its delta propagation), and it reads the YAML from disk rather than having it
// inlined: the Dockerfile copies src/data/libraries into the image, and the
// script passes that directory explicitly because `__dirname` here is `dist/`.
await build({
    ...common,
    entryPoints: ['scripts/sync-framework-libraries.ts'],
    outfile: 'dist/sync-framework-libraries.mjs',
});

// Runs after the two seeders above: fills the checklist of an already-installed
// template task from the steps its template now carries.
await build({
    ...common,
    entryPoints: ['scripts/backfill-task-checklists.ts'],
    outfile: 'dist/backfill-task-checklists.mjs',
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

console.log('✓ built dist/worker.mjs + dist/scheduler.mjs + dist/seed-self-assessments.mjs + dist/seed-policy-templates.mjs + dist/seed-vendor-questionnaires.mjs + dist/seed-control-template-tasks.mjs + dist/seed-framework-catalogs.mjs + dist/sync-framework-libraries.mjs + dist/backfill-task-checklists.mjs + dist/catalog-check.mjs');
