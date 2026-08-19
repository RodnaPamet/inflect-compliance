// Provide mandatory env vars for src/env.ts validation during tests.
//
// For DATABASE_URL: shell env wins; then try .env (the normal local-dev
// pattern — no need to re-source the file for `npm test`); then fall
// back to a dummy URL that lets env validation pass for unit tests
// that mock Prisma. Integration tests that actually connect will still
// use whichever real URL we resolved here.
if (!process.env.DATABASE_URL) {
  try {
    const fs = require('fs');
    const path = require('path');
    const envContent = fs.readFileSync(path.resolve(__dirname, '.env'), 'utf8');
    const match = envContent.match(/^DATABASE_URL="?([^"\n]*)"?$/m);
    if (match && match[1]) process.env.DATABASE_URL = match[1];
  } catch { /* no .env — fall through to dummy */ }
}
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/testdb';

// Per-worker DB isolation (flake fix): when globalSetup created one DB
// per Jest worker, repoint THIS worker's DATABASE_URL at its own clone
// so the app's prisma client and the test prisma client (db.ts
// getTestDatabaseUrl) connect to the SAME isolated DB. Without this the
// app writes to the base DB while the test reads the worker DB. Serial
// runs / CI (marker.perWorker === false) leave DATABASE_URL untouched.
try {
  const fs = require('fs');
  const path = require('path');
  // Repo-local marker path (see PER_WORKER_MARKER in tests/helpers/db.ts).
  const marker = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'node_modules/.cache/inflect-test-perworker.json'), 'utf8'),
  );
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
