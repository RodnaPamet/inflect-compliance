/**
 * Scheduled Job Scope Audit — Cross-Job Tenant Isolation Guard
 *
 * This test suite acts as a structural guard to ensure every scheduled
 * job's executor properly propagates tenantId from payload to the
 * underlying service function. If a new job is added without tenant
 * scoping, these tests catch it.
 *
 * Tests verify:
 * 1. Every job payload with tenantId passes it through the executor
 * 2. The executor-registry wiring does not silently drop tenantId
 * 3. Known tenant-scoped services accept tenantId in their API signatures
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ═════════════════════════════════════════════════════════════════════
// 1. Executor Registry — tenantId propagation audit
// ═════════════════════════════════════════════════════════════════════

describe('Executor Registry — tenantId propagation audit', () => {
    const registryPath = resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts');
    const registrySource = readFileSync(registryPath, 'utf8');

    /**
     * Extract each executor registration block and verify that if the
     * payload type has tenantId, the executor references payload.tenantId.
     */
    test('no executor silently ignores payload.tenantId', () => {
        // Walk register(...) blocks via brace-counting — a non-greedy
        // regex stops at the first inner `});` and misses outer body
        // content for executors with nested closures (e.g.
        // evidence-import passing an async progress callback to
        // runEvidenceImport). The tenantId reference may appear AFTER
        // the inner closure (in the result/payload), so we need the
        // full body, not just the prefix up to the first `});`.
        const openerRe =
            /executorRegistry\.register\('([^']+)',\s*async\s*\(([^)]*)\)\s*=>\s*\{/g;
        const violations: string[] = [];

        let opener: RegExpExecArray | null;
        while ((opener = openerRe.exec(registrySource)) !== null) {
            const jobName = opener[1];
            const paramName = opener[2].trim();
            const start = opener.index + opener[0].length;
            let depth = 1;
            let i = start;
            while (i < registrySource.length && depth > 0) {
                const ch = registrySource[i];
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
                i++;
            }
            const body = registrySource.slice(start, i - 1);

            // Skip jobs that don't need tenantId in the executor: health-check,
            // sync-pull, and the global cron sweeps that scan every tenant and
            // scope each query by the row's own tenantId internally (PR-E's
            // schedule-trigger-sweep scopes by rule.tenantId in its runner +
            // the per-(rule,entity) dispatch it enqueues).
            // sharepoint-delta-sync-dispatch is a global fan-out (SP-3): it scans
            // every enabled connection across tenants and enqueues a per-connection
            // (tenant-scoped) sharepoint-delta-sync job that does reference tenantId.
            // dau-mau-aggregator + onboarding-abandonment-sweep are
            // cross-tenant business-KPI sweeps (aggregate/scan all tenants),
            // same class as risk-snapshot / report-delivery.
            // nvd-cve-sync ingests the global NVD CVE feed (provider-wide,
            // not tenant-scoped) — the per-tenant asset matching runs
            // separately, so this executor legitimately has no tenantId.
            // compliance-posture-summary-dispatch is a global fan-out: it scans
            // all active tenants and enqueues a per-tenant `{tenantId}` job each
            // (the per-tenant `compliance-posture-summary` executor scopes to
            // payload.tenantId via runInTenantContext).
            // identity-sync-dispatch (PR-2) is a global fan-out: it scans
            // enabled identity connections across tenants and enqueues a
            // per-connection identity-sync (which IS tenant-scoped).
            if (['health-check', 'sync-pull', 'schedule-trigger-sweep', 'sharepoint-delta-sync-dispatch', 'sharepoint-subscription-renew', 'risk-appetite-monitor', 'risk-snapshot', 'report-delivery', 'dau-mau-aggregator', 'onboarding-abandonment-sweep', 'nvd-cve-sync', 'compliance-posture-summary-dispatch', 'identity-sync-dispatch', 'hris-sync-dispatch'].includes(jobName)) continue;

            // If the parameter is named _payload, it means tenantId is being ignored
            if (paramName.startsWith('_')) {
                violations.push(
                    `${jobName}: parameter named "${paramName}" — tenantId is likely ignored`
                );
                continue;
            }

            // The body should reference payload.tenantId somewhere
            if (!body.includes('tenantId')) {
                violations.push(
                    `${jobName}: executor body does not reference tenantId`
                );
            }
        }

        expect(violations).toEqual([]);
    });

    /**
     * Verify that no executor uses _payload (underscore-prefixed = unused).
     * This was the exact pattern that caused the policy-review-reminder bug.
     */
    test('no executor uses _payload (unused parameter pattern)', () => {
        const underscorePattern = /executorRegistry\.register\('[^']+',\s*async\s*\(_payload\)/g;
        const matches = registrySource.match(underscorePattern) || [];
        expect(matches).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Service API — tenantId acceptance audit
// ═════════════════════════════════════════════════════════════════════

describe('Service API — tenantId acceptance audit', () => {
    const services = [
        {
            name: 'vendor-renewals',
            path: 'src/app-layer/services/vendor-renewals.ts',
            expectedPattern: /tenantId/,
        },
        {
            name: 'policyReviewReminder',
            path: 'src/app-layer/jobs/policyReviewReminder.ts',
            expectedPattern: /tenantId/,
        },
    ];

    for (const svc of services) {
        test(`${svc.name} accepts tenantId in its API`, () => {
            const source = readFileSync(resolve(__dirname, '../../', svc.path), 'utf8');
            expect(source).toMatch(svc.expectedPattern);
        });
    }

    /**
     * Verify that the vendor-renewals service uses tenantFilter pattern.
     * This ensures the fix is structural, not just a parameter addition.
     */
    test('vendor-renewals service applies tenantFilter to queries', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/services/vendor-renewals.ts'),
            'utf8'
        );
        // Must spread tenantFilter into all 4 query where clauses
        const filterApplications = (source.match(/\.\.\.tenantFilter/g) || []).length;
        expect(filterApplications).toBeGreaterThanOrEqual(4);
    });

    /**
     * Verify that policyReviewReminder adds tenantId to its where clause.
     */
    test('policyReviewReminder applies tenantId to query where', () => {
        const source = readFileSync(
            resolve(__dirname, '../../src/app-layer/jobs/policyReviewReminder.ts'),
            'utf8'
        );
        expect(source).toMatch(/if\s*\(tenantId\)\s*where\.tenantId\s*=\s*tenantId/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Schedule definitions — no tenant-scoped job runs without tenantId
// ═════════════════════════════════════════════════════════════════════

describe('Schedule definitions — scope clarity', () => {
    test('scheduled jobs with empty defaultPayload are system-wide by design', () => {
        // This is a documentation guard — all scheduled cron jobs run without
        // tenantId, which means they are system-wide. This is intentional.
        // Tenant-scoped execution only happens via notification-dispatch or
        // direct executor calls with a specific tenantId.
        const schedulesPath = resolve(__dirname, '../../src/app-layer/jobs/schedules.ts');
        const source = readFileSync(schedulesPath, 'utf8');

        // No schedule should hardcode a specific tenantId
        expect(source).not.toMatch(/tenantId:\s*'/);
        expect(source).not.toMatch(/tenantId:\s*"/);
    });
});
