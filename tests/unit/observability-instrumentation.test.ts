/**
 * Observability Instrumentation Tests — Epic 19 Phase 3
 *
 * Tests for:
 * 1. Route normalization (cardinality safety)
 * 2. Request metrics record correctly with normalized routes
 * 3. Job metrics record on success and failure
 * 4. Queue depth reporting initializes correctly
 * 5. No high-cardinality label misuse
 * 6. Metric names align with dashboard/alert conventions
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

// ─── 1. Route Normalization ─────────────────────────────────────────────

describe('normalizeRoute — cardinality safety', () => {
    // Import the function under test
    let normalizeRoute: (pathname: string) => string;

    beforeAll(() => {
        const mod = require('../../src/lib/observability/metrics');
        normalizeRoute = mod.normalizeRoute;
    });

    it('should collapse UUIDs into :id', () => {
        const route = '/api/t/acme/controls/550e8400-e29b-41d4-a716-446655440000';
        const normalized = normalizeRoute(route);
        expect(normalized).toBe('/api/t/:tenantSlug/controls/:id');
    });

    it('should collapse multiple UUIDs in a path', () => {
        const route = '/api/t/acme/controls/550e8400-e29b-41d4-a716-446655440000/evidence/660e8400-e29b-41d4-a716-446655440001';
        const normalized = normalizeRoute(route);
        expect(normalized).toBe('/api/t/:tenantSlug/controls/:id/evidence/:id');
    });

    it('should normalize tenant slug to :tenantSlug', () => {
        const route = '/api/t/my-company/dashboard';
        const normalized = normalizeRoute(route);
        expect(normalized).toBe('/api/t/:tenantSlug/dashboard');
    });

    it('should handle page routes under /t/[tenantSlug]/', () => {
        const route = '/t/acme-corp/controls';
        const normalized = normalizeRoute(route);
        expect(normalized).toBe('/t/:tenantSlug/controls');
    });

    it('should not modify static API routes', () => {
        expect(normalizeRoute('/api/livez')).toBe('/api/livez');
        expect(normalizeRoute('/api/readyz')).toBe('/api/readyz');
        expect(normalizeRoute('/api/health')).toBe('/api/health');
    });

    it('should not modify auth routes', () => {
        expect(normalizeRoute('/api/auth/login')).toBe('/api/auth/login');
        expect(normalizeRoute('/api/auth/register')).toBe('/api/auth/register');
    });

    it('should collapse long opaque IDs (20+ chars)', () => {
        const route = '/api/t/acme/files/cm5abc123def456ghi789jkl';
        const normalized = normalizeRoute(route);
        expect(normalized).toContain(':id');
        expect(normalized).not.toContain('cm5abc');
    });

    it('should keep short path segments (low cardinality)', () => {
        const route = '/api/t/acme/controls';
        const normalized = normalizeRoute(route);
        expect(normalized).toBe('/api/t/:tenantSlug/controls');
    });

    it('should handle case-insensitive UUIDs', () => {
        const upper = '/api/controls/550E8400-E29B-41D4-A716-446655440000';
        const lower = '/api/controls/550e8400-e29b-41d4-a716-446655440000';
        expect(normalizeRoute(upper)).toBe(normalizeRoute(lower));
    });

    it('should handle root API path', () => {
        expect(normalizeRoute('/api')).toBe('/api');
    });

    it('should produce consistent output for same logical route', () => {
        const r1 = normalizeRoute('/api/t/tenant-a/controls/550e8400-e29b-41d4-a716-446655440000');
        const r2 = normalizeRoute('/api/t/tenant-b/controls/660e8400-e29b-41d4-a716-446655440001');
        expect(r1).toBe(r2);
    });
});

// ─── 2. Request Metrics ─────────────────────────────────────────────────

describe('recordRequestMetrics', () => {
    let recordRequestMetrics: (attrs: { method: string; route: string; status: number; durationMs: number }) => void;

    beforeAll(() => {
        const mod = require('../../src/lib/observability/metrics');
        recordRequestMetrics = mod.recordRequestMetrics;
    });

    it('should be a callable function', () => {
        expect(typeof recordRequestMetrics).toBe('function');
    });

    it('should not throw when recording metrics', () => {
        expect(() => recordRequestMetrics({
            method: 'GET',
            route: '/api/t/acme/controls',
            status: 200,
            durationMs: 42,
        })).not.toThrow();
    });

    it('should not throw with UUID-containing routes (normalization applied internally)', () => {
        expect(() => recordRequestMetrics({
            method: 'GET',
            route: '/api/t/acme/controls/550e8400-e29b-41d4-a716-446655440000',
            status: 200,
            durationMs: 100,
        })).not.toThrow();
    });

    it('should not throw for error responses', () => {
        expect(() => recordRequestMetrics({
            method: 'POST',
            route: '/api/t/acme/controls',
            status: 500,
            durationMs: 500,
        })).not.toThrow();
    });
});

describe('recordRequestError', () => {
    let recordRequestError: (attrs: { method: string; route: string; errorCode: string }) => void;

    beforeAll(() => {
        const mod = require('../../src/lib/observability/metrics');
        recordRequestError = mod.recordRequestError;
    });

    it('should be a callable function', () => {
        expect(typeof recordRequestError).toBe('function');
    });

    it('should not throw when recording errors', () => {
        expect(() => recordRequestError({
            method: 'GET',
            route: '/api/t/acme/controls/550e8400-e29b-41d4-a716-446655440000',
            errorCode: 'INTERNAL_ERROR',
        })).not.toThrow();
    });
});

// ─── 3. Job Metrics ─────────────────────────────────────────────────────

describe('recordJobMetrics', () => {
    let recordJobMetrics: (attrs: { jobName: string; success: boolean; durationMs: number }) => void;

    beforeAll(() => {
        const mod = require('../../src/lib/observability/metrics');
        recordJobMetrics = mod.recordJobMetrics;
    });

    it('should be a callable function', () => {
        expect(typeof recordJobMetrics).toBe('function');
    });

    it('should not throw for successful job', () => {
        expect(() => recordJobMetrics({
            jobName: 'health-check',
            success: true,
            durationMs: 15,
        })).not.toThrow();
    });

    it('should not throw for failed job', () => {
        expect(() => recordJobMetrics({
            jobName: 'automation-runner',
            success: false,
            durationMs: 5000,
        })).not.toThrow();
    });

    it('should accept all registered job names', () => {
        const jobNames = [
            'health-check', 'automation-runner', 'daily-evidence-expiry',
            'data-lifecycle', 'policy-review-reminder', 'retention-sweep',
            'vendor-renewal-check', 'deadline-monitor', 'evidence-expiry-monitor',
            'notification-dispatch', 'sync-pull',
        ];

        for (const name of jobNames) {
            expect(() => recordJobMetrics({
                jobName: name,
                success: true,
                durationMs: 100,
            })).not.toThrow();
        }
    });
});

// ─── 4. Queue Depth Reporting ───────────────────────────────────────────

describe('startQueueDepthReporting', () => {
    let startQueueDepthReporting: (getQueueFn: () => { getJobCounts: () => Promise<Record<string, number>> }) => void;
    let _resetQueueDepthForTesting: () => void;

    beforeAll(() => {
        const mod = require('../../src/lib/observability/metrics');
        startQueueDepthReporting = mod.startQueueDepthReporting;
        _resetQueueDepthForTesting = mod._resetQueueDepthForTesting;
    });

    afterEach(() => {
        _resetQueueDepthForTesting();
    });

    it('should be a callable function', () => {
        expect(typeof startQueueDepthReporting).toBe('function');
    });

    it('should not throw when initializing with a mock queue', () => {
        const mockQueue = {
            getJobCounts: async () => ({
                waiting: 5,
                active: 2,
                delayed: 3,
                failed: 1,
                completed: 100,
            }),
        };

        expect(() => startQueueDepthReporting(() => mockQueue)).not.toThrow();
    });

    it('should be idempotent (safe to call multiple times)', () => {
        const mockQueue = {
            getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
        };

        expect(() => {
            startQueueDepthReporting(() => mockQueue);
            startQueueDepthReporting(() => mockQueue); // second call
        }).not.toThrow();
    });
});

// ─── 5. High-Cardinality Guard ──────────────────────────────────────────

describe('label cardinality safety', () => {
    let normalizeRoute: (pathname: string) => string;

    beforeAll(() => {
        normalizeRoute = require('../../src/lib/observability/metrics').normalizeRoute;
    });

    it('should produce a bounded set of route labels for tenant API routes', () => {
        // Simulate 100 different tenants hitting the same logical route
        const routes = Array.from({ length: 100 }, (_, i) =>
            normalizeRoute(`/api/t/tenant-${i}/controls`)
        );

        const unique = new Set(routes);
        expect(unique.size).toBe(1); // All collapse to same normalized route
    });

    it('should produce a bounded set for entity-specific routes', () => {
        // Simulate 100 different entity UUIDs
        const routes = Array.from({ length: 100 }, (_, i) => {
            const uuid = `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`;
            return normalizeRoute(`/api/t/acme/controls/${uuid}`);
        });

        const unique = new Set(routes);
        expect(unique.size).toBe(1); // All collapse to same normalized route
    });

    it('should never include raw tenant slugs in metric labels', () => {
        const sensitiveRoutes = [
            '/api/t/secret-company/controls',
            '/api/t/my-unicorn-startup/evidence',
            '/t/enterprise-client-42/dashboard',
        ];

        for (const route of sensitiveRoutes) {
            const normalized = normalizeRoute(route);
            expect(normalized).not.toContain('secret-company');
            expect(normalized).not.toContain('my-unicorn-startup');
            expect(normalized).not.toContain('enterprise-client-42');
        }
    });
});

// ─── 6. Metric Name Convention Alignment ────────────────────────────────

describe('metric names align with dashboard/alerts', () => {
    it('should define all metric names referenced in the Grafana dashboard', () => {
        const metricsCode = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/metrics.ts'), 'utf-8'
        ));

        // Dashboard uses Prometheus convention (underscores),
        // code uses OTel convention (dots). Verify the dot-notation names.
        expect(metricsCode).toContain("'api.request.count'");
        expect(metricsCode).toContain("'api.request.duration'");
        expect(metricsCode).toContain("'api.request.errors'");
        expect(metricsCode).toContain("'job.execution.count'");
        expect(metricsCode).toContain("'job.execution.duration'");
        expect(metricsCode).toContain("'job.queue.depth'");
    });

    it('should use consistent label names', () => {
        const metricsCode = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/metrics.ts'), 'utf-8'
        ));

        // Request labels
        expect(metricsCode).toContain("'http.method'");
        expect(metricsCode).toContain("'http.route'");
        expect(metricsCode).toContain("'http.status_code'");

        // Job labels
        expect(metricsCode).toContain("'job.name'");
        expect(metricsCode).toContain("'job.status'");

        // Queue labels
        expect(metricsCode).toContain("'queue.name'");
        expect(metricsCode).toContain("'queue.state'");
    });

    it('should only use bounded label values for job.status', () => {
        const metricsCode = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/metrics.ts'), 'utf-8'
        ));

        // job.status should map to exactly 'success' or 'failure'
        expect(metricsCode).toContain("'success'");
        expect(metricsCode).toContain("'failure'");
    });

    it('should only report bounded queue states', () => {
        const metricsCode = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/metrics.ts'), 'utf-8'
        ));

        // Only report meaningful BullMQ states
        expect(metricsCode).toContain("'waiting'");
        expect(metricsCode).toContain("'active'");
        expect(metricsCode).toContain("'delayed'");
        expect(metricsCode).toContain("'failed'");
    });
});

// ─── 7. Job Metrics Integration ─────────────────────────────────────────

describe('job-runner records metrics', () => {
    it('should import recordJobMetrics', () => {
        const code = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/job-runner.ts'), 'utf-8'
        ));
        expect(code).toContain("import { recordJobMetrics } from './metrics'");
    });

    it('should call recordJobMetrics on success path', () => {
        const code = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/job-runner.ts'), 'utf-8'
        ));
        expect(code).toContain('recordJobMetrics({ jobName, success: true, durationMs })');
    });

    it('should call recordJobMetrics on failure path', () => {
        const code = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/job-runner.ts'), 'utf-8'
        ));
        expect(code).toContain('recordJobMetrics({ jobName, success: false, durationMs })');
    });
});

describe('executor-registry records metrics', () => {
    it('should import recordJobMetrics', () => {
        const code = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts'), 'utf-8'
        ));
        expect(code).toContain("import { recordJobMetrics } from '@/lib/observability/metrics'");
    });

    it('should call recordJobMetrics on success path', () => {
        const code = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts'), 'utf-8'
        ));
        expect(code).toContain('recordJobMetrics({');
        expect(code).toContain('success: result.success');
    });

    it('should call recordJobMetrics on failure path (executor throws)', () => {
        const code = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts'), 'utf-8'
        ));
        expect(code).toContain('recordJobMetrics({ jobName: name, success: false, durationMs })');
    });
});

// ─── 8. normalizeRoute is exported from barrel ──────────────────────────

describe('barrel exports', () => {
    it('should export normalizeRoute from observability barrel', () => {
        const barrel = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/lib/observability/index.ts'), 'utf-8'
        ));
        expect(barrel).toContain('normalizeRoute');
        expect(barrel).toContain('recordJobMetrics');
        expect(barrel).toContain('startQueueDepthReporting');
    });
});
