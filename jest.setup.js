// Provide mandatory env vars for src/env.ts validation during tests.
//
// For DATABASE_URL: shell env wins; then `.env` (the normal local-dev
// pattern — no need to re-source the file for `npm test`); then `.env.test`;
// then a dummy URL that lets env validation pass for unit tests that mock
// Prisma.
//
// `.env.test` IS THE ONE THAT MATTERS LOCALLY, and it was missing. `.env` is
// gitignored and a fresh clone does not have one, so this fell straight to the
// dummy on port 5432 — while `tests/helpers/db.ts` resolves the TEST CLIENT
// independently, and correctly, to the 5434 container. An integration test that
// only reads through `prismaTestClient()` therefore passes, and one that drives
// a USECASE fails with `Can't reach database server at 127.0.0.1:5432`, because
// `runInTenantContext` goes through the app's DATABASE_URL. Two different URLs
// in one process, one of them a placeholder.
//
// It never bites CI, which exports DATABASE_URL — so the cost lands entirely on
// whoever is writing a usecase-level integration test locally, and it reads as
// "my test is broken" rather than "my env is unset".
function readEnvFileUrl(file) {
  try {
    const fs = require('fs');
    const path = require('path');
    const content = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    const match = content.match(/^DATABASE_URL="?([^"\n]*)"?$/m);
    return match && match[1] ? match[1] : null;
  } catch {
    return null; // file absent — try the next source
  }
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    readEnvFileUrl('.env') || readEnvFileUrl('.env.test') || '';
}
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/testdb';

// Per-worker DB isolation (flake fix): when globalSetup created one DB
// per Jest worker, repoint THIS worker's DATABASE_URL at its own clone
// so the app's prisma client and the test prisma client (db.ts
// getTestDatabaseUrl) connect to the SAME isolated DB. Without this the
// app writes to the base DB while the test reads the worker DB. Serial
// runs / CI (marker.perWorker === false) leave DATABASE_URL untouched.
//
// WHICH marker: THIS RUN's own, named by globalSetup in the environment the
// workers inherit (`currentRunMarker`, from the same CommonJS module that
// tests/helpers/db.ts reads it through). It used to be derived here: first a
// literal shared by every worktree (they symlink node_modules), then a name
// per checkout, which two runs in ONE checkout still shared (#4610). A run
// read whichever had started Jest last. See the header of
// tests/helpers/test-db-checkout.js.
//
// No marker named means globalSetup did not run for this process (the scan or
// jsdom project on its own, a bare node script): shared-DB mode.
//
// The require sits OUTSIDE the try on purpose. Inside it, a renamed or broken
// helper would be swallowed as "no marker", and every worker would quietly
// fall back to the shared base database while globalSetup had created
// per-worker ones. A missing helper must fail the run, not degrade it.
const { currentRunMarker } = require('./tests/helpers/test-db-checkout');
const runMarker = currentRunMarker();
try {
  const fs = require('fs');
  const marker = runMarker ? JSON.parse(fs.readFileSync(runMarker, 'utf8')) : { perWorker: false };
  if (marker.perWorker) {
    const u = new URL(marker.baseUrl);
    const wid = process.env.JEST_WORKER_ID || '1';
    // Take the name globalSetup RECORDED creating. This file is plain JS and
    // cannot import the TS helper that owns the naming scheme, so the only
    // alternative is re-deriving it here — which is how this site drifted in
    // the first place: it spelled `baseName + '_w' + wid` while the helper
    // moved on, and the worker then connected to a database nobody created.
    // Reading the record cannot drift.
    const recorded = Array.isArray(marker.workerDbs) ? marker.workerDbs[Number(wid) - 1] : null;
    u.pathname = '/' + (recorded || marker.baseName + '_w' + wid);
    process.env.DATABASE_URL = u.toString();
    process.env.DIRECT_DATABASE_URL = u.toString();
  }
} catch { /* no marker → shared-DB mode, leave DATABASE_URL as resolved */ }
process.env.AUTH_SECRET = 'supersecretstringthatis16charplus'; // pragma: allowlist secret -- test fixture
process.env.JWT_SECRET = 'supersecretstringthatis16charplus'; // pragma: allowlist secret -- test fixture
process.env.GOOGLE_CLIENT_ID = 'test-google-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'; // pragma: allowlist secret -- test fixture
process.env.MICROSOFT_CLIENT_ID = 'test-ms-id';
process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-secret';
process.env.UPLOAD_DIR = 'uploads';
// Tests use local filesystem storage, never s3 (the default would require an
// S3_BUCKET). Root stays UPLOAD_DIR ('uploads') so storage tests' path
// expectations hold.
process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || 'local';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';

// Note: tests/unit/env.test.ts clears this and runs in a separate process
// so it can still test the actual validation logic.
// We set this to prevent env loader from crashing other unit tests.
process.env.SKIP_ENV_VALIDATION = '1';

// Polyfill global fail() for guard tests (removed in newer Jest versions)
if (typeof globalThis.fail === 'undefined') {
  globalThis.fail = (message) => {
    throw new Error(typeof message === 'string' ? message : 'Test failed via fail()');
  };
}

// Jest's jsdom environment doesn't expose `TextEncoder` / `TextDecoder`
// on globalThis — Node has them, but Jest's jsdom stripping doesn't
// pass them through. Some unit tests use `@jest-environment jsdom`
// and transitively load `@prisma/client`, which pulls in `cuid2`
// → `@noble/hashes` → `new TextEncoder()` at module load. Without
// this polyfill those tests fail with "TextEncoder is not defined".
// Cheap workaround pinned to the Node-builtin implementation.
if (typeof globalThis.TextEncoder === 'undefined') {

  const { TextEncoder, TextDecoder } = require('node:util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}
