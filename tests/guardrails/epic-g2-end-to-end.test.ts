/**
 * Epic G-2 — End-to-end readiness guardrail.
 *
 * Locks the full chain that turns a user's "schedule this plan"
 * click into a queued runner job, a materialised ControlTestRun,
 * an attached evidence row, and a dashboard reflection. If any
 * link in this chain is silently dewired by a future PR, this
 * test fires.
 *
 * Coverage map (each numbered point is asserted below):
 *
 *   [1] BullMQ schedule registered           → schedules.ts
 *   [2] Scheduler executor registered        → executor-registry.ts
 *   [3] Runner executor registered           → executor-registry.ts
 *   [4] Schedule PUT route exists            → app/api/.../schedule/route.ts
 *   [5] Upcoming GET route exists            → app/api/.../upcoming/route.ts
 *   [6] Dashboard route merges G-2 fields    → app/api/.../dashboard/route.ts
 *   [7] Schedule picker mounts               → tests/[planId]/page.tsx
 *   [8] Dashboard G-2 section mounts         → tests/dashboard/page.tsx
 *   [9] AutomationType + scheduling fields   → schema files
 *
 * Each assertion targets a specific load-bearing string. Mutation
 * regression coverage is provided by the per-prompt guardrails
 * (control-test-plan-scheduling-schema.test.ts and
 * control-test-scheduler-registration.test.ts) — this test is
 * about whole-chain integrity, not detector validation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readPrismaSchema } from '../helpers/prisma-schema';

import { codeOf } from '../helpers/source-blocks';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

function fileExists(rel: string): boolean {
    return fs.existsSync(path.join(REPO_ROOT, rel));
}

describe('Epic G-2 — end-to-end readiness', () => {
    // [1]
    test('control-test-scheduler is registered in SCHEDULED_JOBS with the every-5-min cron', () => {
        const text = read('src/app-layer/jobs/schedules.ts');
        expect(text).toMatch(/name:\s*'control-test-scheduler'/);
        const after = text.split(/name:\s*'control-test-scheduler'/)[1] ?? '';
        expect(after.slice(0, 400)).toMatch(/pattern:\s*'\*\/5 \* \* \* \*'/);
    });

    // [2]
    test('scheduler executor is registered', () => {
        const text = read('src/app-layer/jobs/executor-registry.ts');
        expect(text).toMatch(
            /executorRegistry\.register\(\s*'control-test-scheduler'/,
        );
    });

    // [3]
    test('runner executor is registered', () => {
        const text = read('src/app-layer/jobs/executor-registry.ts');
        expect(text).toMatch(
            /executorRegistry\.register\(\s*'control-test-runner'/,
        );
    });

    // [4]
    test('PUT /tests/plans/[planId]/schedule route exists and uses scheduleTestPlan', () => {
        const rel =
            'src/app/api/t/[tenantSlug]/tests/plans/[planId]/schedule/route.ts';
        expect(fileExists(rel)).toBe(true);
        const text = read(rel);
        expect(text).toMatch(/export const PUT/);
        expect(text).toMatch(/scheduleTestPlan\b/);
        expect(text).toMatch(/ScheduleTestPlanSchema\b/);
    });

    // [5] PR-Q — the standalone GET /tests/upcoming route + getUpcomingTests
    // usecase were removed as dead surface (no UI consumer; the dashboard's
    // "upcoming" list comes from getTestDashboard). Assert they stay gone.
    test('GET /tests/upcoming route + getUpcomingTests usecase are removed (PR-Q)', () => {
        expect(fileExists('src/app/api/t/[tenantSlug]/tests/upcoming/route.ts')).toBe(false);
        expect(read('src/app-layer/usecases/test-scheduling.ts')).not.toMatch(/export async function getUpcomingTests\b/);
    });

    // [6]
    test('dashboard route merges legacy + G-2 usecases', () => {
        const text = read(
            'src/app/api/t/[tenantSlug]/tests/dashboard/route.ts',
        );
        // Merging requires importing both halves.
        expect(text).toMatch(/getTestDashboardMetrics\b/);
        expect(text).toMatch(/getTestDashboard\b/);
        // Promise.all keeps the two reads parallel — without it the
        // dashboard double-bills DB time.
        expect(text).toMatch(/Promise\.all\b/);
        // Output spreads both halves.
        expect(text).toMatch(/automation:\s*g2\.automation/);
        expect(text).toMatch(/upcoming:\s*g2\.upcoming/);
        expect(text).toMatch(/trend:\s*g2\.trend/);
    });

    // [7] PR-Q — the plan-detail body was extracted into the shared
    // TestPlanDetailView (mounted by both the control-scoped and the new
    // tenant-wide /tests/plans/[planId] routes); the schedule picker lives there.
    test('shared test-plan detail view mounts the schedule picker', () => {
        const text = read(
            'src/components/test-plans/TestPlanDetailView.tsx',
        );
        expect(text).toMatch(/import.+TestPlanScheduleSection.+from\s+'@\/components\/TestPlanScheduleSection'/);
        expect(text).toMatch(/<TestPlanScheduleSection\b/);
    });

    // [8]
    test('test dashboard page mounts the G-2 section', () => {
        const text = read(
            'src/app/t/[tenantSlug]/(app)/tests/dashboard/page.tsx',
        );
        expect(text).toMatch(/import\s*\{\s*TestDashboardG2Section/);
        expect(text).toMatch(/<TestDashboardG2Section\b/);
    });

    // [9]
    test('schema carries the G-2 enum and scheduling fields on ControlTestPlan', () => {
        const enums = read('prisma/schema/enums.prisma');
        const compliance = codeOf(readPrismaSchema());
        expect(enums).toMatch(/enum AutomationType\s*\{[\s\S]*?MANUAL[\s\S]*?\}/);

        const planMatch = compliance.match(
            /model ControlTestPlan \{([\s\S]*?)\n\}/,
        );
        expect(planMatch).not.toBeNull();
        const body = planMatch![1];
        for (const field of [
            'automationType',
            'schedule',
            'scheduleTimezone',
            'nextRunAt',
            'lastScheduledRunAt',
            'automationConfig',
        ]) {
            expect(body).toMatch(new RegExp(`\\n\\s+${field}\\s+`));
        }
    });

    // ─── Sanity: end-to-end import path resolves ─────────────────
    //
    // If the static-source assertions above all pass but the import
    // graph is broken (typo in a path, circular cycle, missing
    // export), the runtime would still fail. Importing the
    // top-level entry points here ensures the whole graph resolves
    // under jest's jsdom environment without crashing — a strict
    // upper bound on "ready to deploy".

    test('runtime import graph resolves for every G-2 entry point', async () => {
        await expect(
            import('@/app-layer/jobs/control-test-scheduler'),
        ).resolves.toHaveProperty('runControlTestScheduler');
        await expect(
            import('@/app-layer/jobs/control-test-runner'),
        ).resolves.toHaveProperty('runControlTestRunner');
        await expect(
            import('@/app-layer/usecases/test-scheduling'),
        ).resolves.toHaveProperty('scheduleTestPlan');
        await expect(
            import('@/app-layer/usecases/test-scheduling'),
        ).resolves.toHaveProperty('getTestDashboard');
    });
});
