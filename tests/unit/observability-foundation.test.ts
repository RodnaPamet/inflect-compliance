/**
 * Observability Foundation Tests
 *
 * Tests for Epic 19 Phase 1:
 * 1. No console.* remains in backend/server code (allowlisted exceptions only)
 * 2. Liveness probe always returns 200
 * 3. Readiness probe structure and contract
 * 4. Structured logger compiles and is usable in server code
 * 5. Edge logger compiles and is usable
 * 6. Health probe endpoints bypass auth
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Test 1: No console.* in server code ───────────────────────────────

describe('console.* usage guard', () => {
    it('should have no console.log/warn/error in server-side src/ files except allowlisted', () => {
        const srcDir = path.resolve(__dirname, '../../src');
        const violations: string[] = [];

        // Files that are explicitly allowed to use console.*:
        // - Client components ('use client') — run in browser
        // - Edge logger — the edge runtime shim uses console.* by design
        // - api-client.ts — client-side fetch helper, dev-only validation warning
        const ALLOWED_FILES = new Set([
            // Client-side error boundaries
            'app/error.tsx',
            'app/global-error.tsx',
            'app/t/[tenantSlug]/(app)/error.tsx',
            // Client-side components
            'app/t/[tenantSlug]/(app)/risks/new/page.tsx',
            'components/PdfExportButton.tsx',
            // Edge logger (shim that intentionally wraps console.*)
            'lib/observability/edge-logger.ts',
            // Client-side API helper (dev-only zod validation warning)
            'lib/api-client.ts',
            // Pre-init bootstrap: this is THE file that runs before logger
            // bootstraps. R-6 startup-abort message uses console.error
            // because no other sink exists at that point.
            'instrumentation.ts',
        ]);

        // Utility / chart / interaction files that use console.* by design
        const ALLOWED_PREFIXES = [
            'components/ui/charts/',
            'components/ui/hooks/',
            'components/ui/filter/',
        ];

        const CONSOLE_PATTERN = /console\.(log|warn|error|info|debug)\s*\(/;

        function scanDir(dir: string) {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.next') continue;
                    scanDir(fullPath);
                    continue;
                }

                if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;

                const relPath = path.relative(srcDir, fullPath).replace(/\\/g, '/');
                if (ALLOWED_FILES.has(relPath)) continue;
                if (ALLOWED_PREFIXES.some(p => relPath.startsWith(p))) continue;

                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Skip comments
                    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
                    if (CONSOLE_PATTERN.test(line)) {
                        violations.push(`${relPath}:${i + 1}: ${line.trim()}`);
                    }
                }
            }
        }

        scanDir(srcDir);

        if (violations.length > 0) {
            throw new Error(
                `Found ${violations.length} console.* call(s) in server code that should use the structured logger:\n` +
                violations.map(v => `  ${v}`).join('\n')
            );
        }
    });
});

// ─── Test 2: Structured logger compiles and is usable ──────────────────

describe('structured logger', () => {
    it('should export logger with info/warn/error/debug/fatal methods', () => {
        const { logger } = require('../../src/lib/observability/logger');

        expect(logger).toBeDefined();
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.warn).toBe('function');
        expect(typeof logger.error).toBe('function');
        expect(typeof logger.debug).toBe('function');
        expect(typeof logger.fatal).toBe('function');
    });

    it('should export extractErrorMeta that extracts safe error metadata', () => {
        const { extractErrorMeta } = require('../../src/lib/observability/logger');

        const err = new TypeError('something broke');
        const meta = extractErrorMeta(err);

        expect(meta).toBeDefined();
        expect(meta!.name).toBe('TypeError');
        expect(meta!.message).toBe('something broke');
        expect(meta!.stack).toBeDefined();
    });

    it('should export extractErrorMeta that handles non-Error inputs', () => {
        const { extractErrorMeta } = require('../../src/lib/observability/logger');

        const meta = extractErrorMeta('string error');
        expect(meta!.name).toBe('UnknownError');
        expect(meta!.message).toBe('string error');
    });

    it('should export createChildLogger', () => {
        const { createChildLogger } = require('../../src/lib/observability/logger');

        const child = createChildLogger({ component: 'test-child' });
        expect(child).toBeDefined();
        expect(typeof child.info).toBe('function');
    });

    it('should export pinoInstance', () => {
        const { pinoInstance } = require('../../src/lib/observability/logger');

        expect(pinoInstance).toBeDefined();
        expect(typeof pinoInstance.info).toBe('function');
        expect(pinoInstance.level).toBeDefined();
    });
});

// ─── Test 3: Edge logger compiles and is usable ────────────────────────

describe('edge logger', () => {
    // edge-logger is silent in NODE_ENV=test by default (otherwise every
    // middleware-invoking integration test floods stderr with pino JSON).
    // These tests specifically assert the console-shape contract, so opt
    // back in for the duration of the suite.
    let savedEdgeLoggerInTest: string | undefined;
    beforeAll(() => {
        savedEdgeLoggerInTest = process.env.EDGE_LOGGER_IN_TEST;
        process.env.EDGE_LOGGER_IN_TEST = '1';
    });
    afterAll(() => {
        if (savedEdgeLoggerInTest === undefined) {
            delete process.env.EDGE_LOGGER_IN_TEST;
        } else {
            process.env.EDGE_LOGGER_IN_TEST = savedEdgeLoggerInTest;
        }
    });

    it('should export edgeLogger with info/warn/error/debug methods', () => {
        const { edgeLogger } = require('../../src/lib/observability/edge-logger');

        expect(edgeLogger).toBeDefined();
        expect(typeof edgeLogger.info).toBe('function');
        expect(typeof edgeLogger.warn).toBe('function');
        expect(typeof edgeLogger.error).toBe('function');
        expect(typeof edgeLogger.debug).toBe('function');
    });

    it('should emit structured JSON via console', () => {
        const { edgeLogger } = require('../../src/lib/observability/edge-logger');

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

        edgeLogger.info('test message', { component: 'test' });

        expect(logSpy).toHaveBeenCalledTimes(1);
        const output = logSpy.mock.calls[0][0];
        const parsed = JSON.parse(output);

        expect(parsed.msg).toBe('test message');
        expect(parsed.component).toBe('test');
        expect(parsed.level).toBe(30); // info = 30
        expect(parsed.time).toBeDefined();

        logSpy.mockRestore();
    });

    it('should use console.error for error level', () => {
        const { edgeLogger } = require('../../src/lib/observability/edge-logger');

        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        edgeLogger.error('test error', { component: 'test' });

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
        expect(parsed.level).toBe(50); // error = 50

        errorSpy.mockRestore();
    });
});

// ─── Test 4: Liveness probe ────────────────────────────────────────────

describe('liveness probe (/api/livez)', () => {
    it('should always return 200 with status alive', async () => {
        const { GET } = require('../../src/app/api/livez/route');

        const response = await GET();
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.status).toBe('alive');
        expect(data.timestamp).toBeDefined();
        expect(typeof data.uptime).toBe('number');
    });
});

// ─── Test 5: Readiness probe — contract validation ─────────────────────
// NOTE: The readyz route instantiates PrismaClient at module scope, which
// blocks/hangs in the Jest unit test environment. Readyz is validated via:
//   - Integration tests (npm run test:integration)
//   - Manual verification: curl http://localhost:3000/api/readyz
// The livez probe (no DB dependency) is tested above.

describe('readiness probe (/api/readyz) — file structure', () => {
    it('should have a route file at the expected path', () => {
        const fs = require('fs');
        const routePath = require('path').resolve(__dirname, '../../src/app/api/readyz/route.ts');
        expect(fs.existsSync(routePath)).toBe(true);
    });

    it('should export a GET handler', () => {
        // Verify the route file contains the expected export without importing it
        const fs = require('fs');
        const routePath = require('path').resolve(__dirname, '../../src/app/api/readyz/route.ts');
        const content = fs.readFileSync(routePath, 'utf-8');
        expect(content).toContain('export async function GET');
    });

    it('should check database connectivity', () => {
        const fs = require('fs');
        const routePath = require('path').resolve(__dirname, '../../src/app/api/readyz/route.ts');
        const content = fs.readFileSync(routePath, 'utf-8');
        expect(content).toContain('checkDatabase');
        expect(content).toContain('$queryRaw');
    });

    it('should return 503 on failure (not crash)', () => {
        const fs = require('fs');
        const routePath = require('path').resolve(__dirname, '../../src/app/api/readyz/route.ts');
        const content = fs.readFileSync(routePath, 'utf-8');
        // Verify the route returns 503 status, not throws
        expect(content).toContain('503');
        expect(content).toContain("'not_ready'");
    });
});

// ─── Test 6: Probe public path allowlist ───────────────────────────────

describe('health probe auth bypass', () => {
    it('should mark /api/livez as a public path', () => {
        const { isPublicPath } = require('../../src/lib/auth/guard');
        expect(isPublicPath('/api/livez')).toBe(true);
    });

    it('should mark /api/readyz as a public path', () => {
        const { isPublicPath } = require('../../src/lib/auth/guard');
        expect(isPublicPath('/api/readyz')).toBe(true);
    });

    it('should mark /api/health as a public path (deprecated alias)', () => {
        const { isPublicPath } = require('../../src/lib/auth/guard');
        expect(isPublicPath('/api/health')).toBe(true);
    });
});
