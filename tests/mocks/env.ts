// tests/mocks/env.ts
// This file mocks src/env.ts to bypass @t3-oss/env-nextjs ESM issues in Jest
// It uses a Proxy to dynamically reflect process.env overrides in tests.

export const env = new Proxy({}, {
    get(target, prop: string) {
        if (process.env[prop] !== undefined) {
            return process.env[prop];
        }

        switch (prop) {
            case 'NODE_ENV': return 'test';
            case 'DATABASE_URL': return 'postgres://user:password@localhost:5432/testdb';
            case 'NEXTAUTH_URL': return 'http://localhost:3000';
            case 'AUTH_URL': return 'http://localhost:3000';
            case 'AUTH_SECRET': return 'supersecretstringthatis16charplus';
            case 'JWT_SECRET': return 'supersecretstringthatis16charplus';
            case 'GOOGLE_CLIENT_ID': return 'test-google-id';
            case 'GOOGLE_CLIENT_SECRET': return 'test-google-secret';
            case 'MICROSOFT_CLIENT_ID': return 'test-ms-id';
            case 'MICROSOFT_CLIENT_SECRET': return 'test-ms-secret';
            case 'MICROSOFT_TENANT_ID': return 'test-tenant';
            case 'UPLOAD_DIR': return 'uploads';
            case 'CORS_ALLOWED_ORIGINS': return 'https://myapp.com,http://localhost:3000';
            case 'RATE_LIMIT_ENABLED': return '1';
            case 'RATE_LIMIT_MODE': return 'upstash';
            case 'AUTH_TEST_MODE': return 'true';
            // Mirrors the real default in src/env.ts (`.default("strict")`).
            // Falling through to `undefined` here made `isDownloadAllowed` take
            // its PERMISSIVE branch in every test in the repo, so the strict
            // gate — the one that blocks a file whose scan has not finished —
            // was never once exercised. A mock that answers differently from
            // production turns its suites green without testing the shipped
            // configuration.
            case 'AV_SCAN_MODE': return 'strict';
            default: return undefined;
        }
    }
});
