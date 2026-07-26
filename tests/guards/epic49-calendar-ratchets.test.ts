/**
 * Epic 49 — structural ratchets for the compliance-calendar feature.
 *
 * Locks the wiring contract that's easy to silently break in a
 * "simplify" PR:
 *
 *   1. The Calendar nav item is registered in the sidebar.
 *   2. The Calendar nav item carries a live badge (useCalendarBadge).
 *   3. The command palette has a `nav:calendar` entry.
 *   4. The /calendar page exists and the route handler exists.
 *   5. The shells expose the calendar event contract via
 *      `CalendarEvent` from the schema module.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../..');

function read(p: string): string {
    return fs.readFileSync(path.join(REPO, p), 'utf-8');
}

function exists(p: string): boolean {
    return fs.existsSync(path.join(REPO, p));
}

/**
 * Every per-source loader in the compliance-calendar aggregation. Adding
 * a deadline source means adding it here too — that is deliberate: the
 * list is the checklist for "does the calendar still cover everything it
 * claims to cover".
 */
const CALENDAR_LOADERS = [
    'loadEvidenceEvents',
    'loadPolicyEvents',
    'loadVendorEvents',
    'loadVendorDocumentEvents',
    'loadVendorAssessmentEvents',
    'loadAuditCycleEvents',
    'loadControlEvents',
    'loadTestPlanEvents',
    'loadControlExceptionEvents',
    'loadAccessReviewEvents',
    'loadTrainingEvents',
    'loadIncidentNotificationEvents',
    'loadTaskEvents',
    'loadRiskEvents',
    'loadFindingEvents',
    'loadTreatmentMilestoneEvents',
    'loadTreatmentPlanEvents',
] as const;

describe('Epic 49 — calendar feature wiring', () => {
    it('the Calendar route + page exist', () => {
        expect(
            exists('src/app/t/[tenantSlug]/(app)/calendar/page.tsx'),
        ).toBe(true);
        expect(
            exists('src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx'),
        ).toBe(true);
        expect(
            exists('src/app/api/t/[tenantSlug]/calendar/route.ts'),
        ).toBe(true);
        expect(
            exists(
                'src/app/api/t/[tenantSlug]/calendar/upcoming-count/route.ts',
            ),
        ).toBe(true);
    });

    it('the unified event DTO + Zod query schema exist', () => {
        expect(
            exists('src/app-layer/schemas/calendar.schemas.ts'),
        ).toBe(true);
        const src = read('src/app-layer/schemas/calendar.schemas.ts');
        expect(src).toMatch(/export interface CalendarEvent/);
        expect(src).toMatch(/CALENDAR_EVENT_TYPES\s*=/);
        expect(src).toMatch(/CALENDAR_EVENT_CATEGORIES\s*=/);
        expect(src).toMatch(/CalendarQuerySchema\s*=/);
    });

    it('the aggregation usecase covers every required source', () => {
        const src = read('src/app-layer/usecases/compliance-calendar.ts');
        // Each loader name guards against a future refactor that
        // accidentally drops a source — the calendar would still
        // render but a whole entity class would be invisible.
        for (const fn of CALENDAR_LOADERS) {
            expect(src).toMatch(new RegExp(`function\\s+${fn}\\b`));
        }
    });

    it('every loader is actually WIRED into the fan-out, not just defined', () => {
        // The previous version of this guard only checked that each
        // `function load…` existed. A loader that was defined but never
        // called from the aggregator would pass while contributing zero
        // events — exactly the silent-omission class this file exists to
        // catch. Assert each one is registered in the `CALENDAR_SOURCES`
        // metadata table the fan-out iterates.
        const src = read('src/app-layer/usecases/compliance-calendar.ts');
        const table = src.slice(
            src.indexOf('const CALENDAR_SOURCES:'),
            src.indexOf('] as const;', src.indexOf('const CALENDAR_SOURCES:')),
        );
        expect(table.length).toBeGreaterThan(0);
        for (const fn of CALENDAR_LOADERS) {
            // Each source entry references its loader as `load: <fn>`.
            expect(table).toMatch(new RegExp(`load:\\s*${fn}\\b`));
        }
    });

    it('every loader orders by its date column so a cap keeps the nearest', () => {
        // The per-source cap without an ORDER BY truncates arbitrarily —
        // a busy tenant silently loses its soonest deadlines. Behavioural
        // coverage lives in tests/unit/compliance-calendar.test.ts; this
        // is the structural floor: no capped findMany may issue without an
        // orderBy. Multi-date sources (vendor/risk/audit-cycle/test-plan)
        // issue MORE than one capped query, so `take` count now floors at
        // the loader count rather than equalling it — but every `take` must
        // still be paired with an `orderBy`.
        const src = read('src/app-layer/usecases/compliance-calendar.ts');
        const takeCount = (src.match(/take: limit,/g) ?? []).length;
        const orderByCount = (src.match(/orderBy: /g) ?? []).length;
        expect(takeCount).toBeGreaterThanOrEqual(CALENDAR_LOADERS.length);
        expect(orderByCount).toBeGreaterThanOrEqual(takeCount);
    });

    it('the response carries a truncation report', () => {
        const schemas = read('src/app-layer/schemas/calendar.schemas.ts');
        expect(schemas).toMatch(/truncation:\s*\{/);
        expect(schemas).toMatch(/CALENDAR_SOURCE_NAMES\s*=/);
        // The count summary must be able to say it is partial.
        expect(schemas).toMatch(/partial:\s*boolean/);
        // …and the page must surface it rather than silently under-report.
        const client = read(
            'src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx',
        );
        expect(client).toMatch(/calendar-truncation-notice/);
        expect(client).toMatch(/truncationNotice/);
    });

    it('evidence expiry runs through the one shared predicate', () => {
        // Calendar, ExpiryCalendar list, and the KPI buckets used to
        // define "what's expiring" three different ways and drift.
        const calendar = read('src/app-layer/usecases/compliance-calendar.ts');
        const dashboard = read(
            'src/app-layer/repositories/DashboardRepository.ts',
        );
        for (const src of [calendar, dashboard]) {
            expect(src).toMatch(/evidenceExpiryScopeWhere/);
        }
        // The dead `evidence-expiry` type is gone — it never had a loader.
        const schemas = read('src/app-layer/schemas/calendar.schemas.ts');
        expect(schemas).not.toMatch(/'evidence-expiry'/);
    });

    it('the sidebar Calendar nav item is registered with a live badge', () => {
        const src = read('src/components/layout/SidebarNav.tsx');
        expect(src).toMatch(/useCalendarBadge/);
        // Sidebar nav labels are localised via the `nav` catalog
        // (`t('calendar')` → messages/{en,bg}.json) — the Calendar entry
        // lives in the Comply group. The load-bearing structural anchors
        // are unchanged: same `/calendar` href, same `useCalendarBadge`
        // wiring, same badge prop on the nav item.
        expect(src).toMatch(/label:\s*t\(['"]calendar['"]\)/);
        expect(src).toMatch(/tenantHref\(['"]\/calendar['"]\)/);
        // The badge from `useCalendarBadge` must still be threaded
        // onto the Schedule nav entry — that's the load-bearing
        // visible signal for "items need attention this week".
        expect(src).toMatch(
            /tenantHref\(['"]\/calendar['"]\)[\s\S]{0,400}badge:\s*calendarBadge/,
        );
    });

    it('the command palette has a nav:calendar entry', () => {
        const src = read(
            'src/components/command-palette/use-palette-commands.ts',
        );
        expect(src).toMatch(/id:\s*['"]nav:calendar['"]/);
        expect(src).toMatch(/href\(['"]\/calendar['"]\)/);
    });

    it('the calendar-deadlines monitor exists and exports both helpers', () => {
        expect(exists('src/app-layer/jobs/calendar-deadlines.ts')).toBe(true);
        const src = read('src/app-layer/jobs/calendar-deadlines.ts');
        expect(src).toMatch(/export\s+async\s+function\s+runCalendarDeadlineMonitor/);
        expect(src).toMatch(/export\s+async\s+function\s+runCalendarDeadlineJob/);
        // It must scan the three NEW sources the base deadline monitor
        // doesn't cover. If a future PR drops one of these, deadline
        // notifications for that source disappear silently.
        expect(src).toMatch(/scanAuditCycles/);
        expect(src).toMatch(/scanVendorDocuments/);
        expect(src).toMatch(/scanFindings/);
    });

    it('the orchestrator wires the calendar monitor into DEADLINE_DIGEST', () => {
        const src = read('src/app-layer/jobs/notification-dispatch.ts');
        expect(src).toMatch(/calendar-deadlines/);
        expect(src).toMatch(/runCalendarDeadlineMonitor/);
    });

    it('the upcoming-count helper is bounded by MAX_BADGE_COUNT (cap = 99)', () => {
        const src = read('src/app-layer/usecases/compliance-calendar.ts');
        // Cap value lives next to the function — locking it stops a
        // contributor from removing the cap and shipping a 5-digit
        // badge.
        expect(src).toMatch(/MAX_BADGE_COUNT\s*=\s*99/);
    });
});
