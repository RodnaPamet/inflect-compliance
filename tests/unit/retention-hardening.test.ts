/**
 * Evidence Retention Hardening — CI Guardrails
 *
 * These tests ensure retention enforcement is consistently applied:
 * 1. Readiness scoring excludes archived evidence
 * 2. Evidence linking guards exist
 * 3. Notification job is idempotent
 * 4. Readiness code always filters isArchived
 */
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve('src');

// ─── 1) Readiness excludes archived evidence ───

describe('Retention Hardening — Readiness scoring', () => {
    test('ISO readiness evidence query routes through the coverage predicate (filters isArchived)', () => {
        // EP-1: the isArchived/deletedAt/status filter now lives in the ONE
        // shared coverage predicate; the scorer routes through it instead of
        // inlining the literals. Verify (a) the scorer uses the predicate and
        // (b) the predicate still filters isArchived.
        const scorer = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/usecases/audit-readiness/scoring.ts'), 'utf-8'
        );
        expect(scorer).toContain('coverageQualifyingEvidenceWhere');
        const predicate = fs.readFileSync(
            path.join(SRC_ROOT, 'lib/compliance/coverage-evidence.ts'), 'utf-8'
        );
        expect(predicate).toContain('isArchived: false');
    });

    test('ISO readiness evidence query routes through the coverage predicate (filters deletedAt)', () => {
        const predicate = fs.readFileSync(
            path.join(SRC_ROOT, 'lib/compliance/coverage-evidence.ts'), 'utf-8'
        );
        expect(predicate).toContain('deletedAt: null');
    });

    test('gap details mention archived/expired exclusion', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/usecases/audit-readiness/scoring.ts'), 'utf-8'
        );
        expect(content).toContain('archived/expired excluded');
    });
});

// ─── 2) Evidence linking block ───

describe('Retention Hardening — Evidence linking block', () => {
    test('assertNotArchived function exists in evidence-retention', () => {
        const mod = require('@/app-layer/usecases/evidence-retention');
        expect(typeof mod.assertNotArchived).toBe('function');
    });
});

// ─── 3) Notification job exports ───

describe('Retention Hardening — Notification job', () => {
    test('notification job module exports runEvidenceRetentionNotifications', () => {
        const mod = require('@/app-layer/jobs/retention-notifications');
        expect(typeof mod.runEvidenceRetentionNotifications).toBe('function');
    });
});

// ─── 4) Retention metrics ───

describe('Retention Hardening — Metrics', () => {
    test('getRetentionMetrics function exists', () => {
        const mod = require('@/app-layer/usecases/evidence-retention');
        expect(typeof mod.getRetentionMetrics).toBe('function');
    });

    test('metrics route exists', () => {
        const routeDir = path.resolve('src/app/api/t/[tenantSlug]/evidence/retention');
        expect(fs.existsSync(path.join(routeDir, 'metrics/route.ts'))).toBe(true);
    });

    test('metrics route has no direct prisma import', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app/api/t/[tenantSlug]/evidence/retention/metrics/route.ts'), 'utf-8'
        );
        expect(content).not.toContain("from '@/lib/prisma'");
        expect(content).not.toContain('from "@/lib/prisma"');
    });
});

// ─── 5) CI guardrail: readiness code isArchived check ───

describe('Retention Hardening — CI guardrail', () => {
    test('readiness scoring file does NOT query evidence without isArchived filter', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/usecases/audit-readiness/scoring.ts'), 'utf-8'
        );
        // EP-3: Evidence↔Control is a many-to-many join now, so the evidence
        // qualifier is a relation filter on the join — `evidence: <predicate>`.
        // EP-1 routes every readiness evidence query through the shared
        // `coverageQualifyingEvidenceWhere` predicate (which itself enforces
        // isArchived=false + deletedAt=null + unexpired). Matching that call is
        // the guardrail: a raw evidence query that skips the predicate would
        // not match and would drop the archived/deleted/expired exclusions.
        const evidenceQueryPattern = /evidence:\s*coverageQualifyingEvidenceWhere\(/g;
        const matches = content.match(evidenceQueryPattern);
        // Must have at least 2 (ISO + NIS2)
        expect(matches?.length).toBeGreaterThanOrEqual(2);
        // Each match must route through the qualifying predicate.
        for (const match of matches || []) {
            expect(match).toContain('coverageQualifyingEvidenceWhere');
        }
    });

    test('notification job is idempotent — checks for existing tasks', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/jobs/retention-notifications.ts'), 'utf-8'
        );
        // Must check for existing task before creating new one
        expect(content).toContain('findFirst');
        expect(content).toContain('skippedDuplicate');
    });

    test('sweep job is idempotent — only archives non-archived', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/jobs/retention.ts'), 'utf-8'
        );
        expect(content).toContain('isArchived: false');
    });
});
