/**
 * Calendar UX-completeness ratchet.
 *
 * Locks the seven gaps closed in the calendar UX PR. Each is a
 * regression a plausible "tidy-up" PR would reintroduce:
 *
 *   1. The Timeline pre-filtering itself back down to audit cycles.
 *   2. Loading collapsing back into "looks empty".
 *   3. A surface re-growing its own private "due soon" number.
 *   4. The heatmap going retrospective-only again.
 *   5. Deep-links flattening back to the entity root.
 *   6. Create-from-calendar going back to an undiscoverable dblclick.
 *   7. Off-screen deadlines rendering as an empty view.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLIENT = 'src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx';
const MONTH = 'src/components/ui/CalendarMonth.tsx';
const USECASE = 'src/app-layer/usecases/compliance-calendar.ts';
const EXPIRY = 'src/components/ui/ExpiryCalendar.tsx';
const DASHBOARD_REPO = 'src/app-layer/repositories/DashboardRepository.ts';

describe('1 — the Timeline shows every deadline', () => {
    it('does not pre-filter the Gantt down to range-bearing events', () => {
        const src = read(CLIENT);
        // The old filter kept only `e.end !== undefined || category ===
        // 'audit'`. Only the audit-cycle loader sets `end`, so that made
        // the "Timeline" an audit-cycle view — blank without cycles.
        expect(src).not.toMatch(/e\.end !== undefined \|\| e\.category === 'audit'/);
        expect(src).toMatch(/const ganttEvents = events;/);
    });

    it('relies on the GanttTimeline point-in-time fallback that already exists', () => {
        const gantt = read('src/components/ui/GanttTimeline.tsx');
        // A dateless-end event renders as a 1-day marker; without this the
        // unfiltered feed would collapse to zero-width bars.
        expect(gantt).toMatch(/ev\.end[\s\S]{0,80}startMs \+ DAY_MS/);
    });
});

describe('2 — loading is distinguishable from empty', () => {
    it('renders a pending indicator while the range has no payload', () => {
        const src = read(CLIENT);
        // Pending is derived from SWR's key-aware `isLoading` (the previous
        // `!data && !error` form was permanently false under keepPreviousData,
        // so no spinner ever showed on a range switch).
        expect(src).toMatch(/const pending = calQuery\.isLoading/);
        expect(src).toMatch(/data-testid="calendar-loading"/);
        expect(src).toMatch(/aria-busy=\{pending/);
    });
});

describe('3 — one urgency threshold set', () => {
    it('the shared scale exists and is the only place the numbers live', () => {
        const urgency = read('src/lib/urgency.ts');
        expect(urgency).toMatch(/URGENT: 7/);
        expect(urgency).toMatch(/UPCOMING: 30/);
    });

    it('the calendar classifier reads the shared scale, not a literal', () => {
        const src = read(USECASE);
        // `urgencyFromDaysUntil` (day-granularity, tenant-tz) or the older
        // `urgencyFromDate` (instant) — either is the shared `URGENCY_DAYS`
        // scale. What matters is it is NOT a local literal window.
        expect(src).toMatch(/urgencyFrom(Date|DaysUntil)/);
        // The old inline window.
        expect(src).not.toMatch(/diffMs <= 7 \* 86_400_000/);
    });

    it('the ExpiryCalendar widget reads the shared scale', () => {
        const src = read(EXPIRY);
        expect(src).toMatch(/urgencyFromDaysUntil/);
        // Its private ≤14 tier was the only place 14 appeared anywhere.
        expect(src).not.toMatch(/daysUntil <= 14/);
    });

    it('the dashboard KPI buckets read the shared scale', () => {
        const src = read(DASHBOARD_REPO);
        expect(src).toMatch(/URGENCY_MS\.URGENT/);
        expect(src).toMatch(/URGENCY_MS\.UPCOMING/);
    });
});

describe('4 — the heatmap includes the future', () => {
    it('its window extends past today', () => {
        const src = read(CLIENT);
        expect(src).toMatch(/HEATMAP_FORWARD_DAYS/);
        // The old shape ended the range at `today`.
        expect(src).not.toMatch(/from: new Date\(today\.getTime\(\) - 365 \* DAY_MS\),\s*\n\s*to: today,/);
    });
});

describe('5 — deep-links land on the relevant section', () => {
    it('vendor documents + assessments deep-link to their tab', () => {
        const src = read(USECASE);
        expect(src).toMatch(/\/vendors\/\$\{r\.vendorId\}\?tab=documents/);
        expect(src).toMatch(/\/vendors\/\$\{r\.vendorId\}\?tab=assessments/);
    });

    it('the vendor detail page actually honours ?tab=', () => {
        // A deep-link to a tab the page ignores is worse than no
        // deep-link — it silently lands on Overview.
        const src = read('src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx');
        expect(src).toMatch(/useSearchParams/);
        expect(src).toMatch(/VENDOR_TABS/);
    });

    it('EVERY emitted href resolves to a real route segment', () => {
        // Three event types shipped hrefs to routes that did not exist
        // (`/training`, `/evidence/{id}`, `/findings/{id}`) and 404'd on
        // click — the previous guard only checked the vendor deep-link, so
        // the gap survived. This resolves EVERY `tenantHrefFromCtx(ctx, …)`
        // path against the actual App Router tree.
        const APP = path.join(ROOT, 'src/app/t/[tenantSlug]/(app)');
        const src = read(USECASE);
        const hrefs = [
            ...src.matchAll(/tenantHrefFromCtx\(\s*ctx,\s*`([^`]+)`/g),
        ].map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThanOrEqual(15);

        /** A route dir resolves a segment if it matches literally or is a
         *  `[param]` dir (for a `${…}` interpolation). */
        function resolves(segments: string[]): boolean {
            let dir = APP;
            for (const seg of segments) {
                if (!fs.existsSync(dir)) return false;
                const entries = fs
                    .readdirSync(dir, { withFileTypes: true })
                    .filter((e) => e.isDirectory())
                    .map((e) => e.name);
                if (seg.includes('${')) {
                    // Dynamic interpolation → must match a [param] dir.
                    const dyn = entries.find(
                        (e) => e.startsWith('[') && e.endsWith(']'),
                    );
                    if (!dyn) return false;
                    dir = path.join(dir, dyn);
                } else {
                    if (!entries.includes(seg)) return false;
                    dir = path.join(dir, seg);
                }
            }
            // A leaf route must be renderable.
            return (
                fs.existsSync(path.join(dir, 'page.tsx')) ||
                fs.existsSync(path.join(dir, 'page.ts'))
            );
        }

        const unresolved = hrefs.filter((href) => {
            // Strip the query string AND the #anchor before resolving the path.
            const clean = href.split('?')[0].split('#')[0].replace(/^\//, '');
            const segments = clean.split('/').filter(Boolean);
            return !resolves(segments);
        });
        expect(unresolved).toEqual([]);
    });

    it('distinct event types deep-link to distinct destinations', () => {
        // Four risk event types and two vendor types used to collapse to the
        // same entity root, and control-exception / incident-notification
        // landed on a root that showed no sign of the thing that was due.
        const src = read(USECASE);
        // Risk mitigation target + both treatment types → the treatment plan
        // (assessment tab), distinct from risk-review's overview root. Each
        // href expression is unique to its event type (`${r.id}` = risk-target,
        // `${riskId}` = milestone, `${r.riskId}` = plan target).
        expect(src).toMatch(/\/risks\/\$\{r\.id\}\?tab=assessment/);
        expect(src).toMatch(/\/risks\/\$\{riskId\}\?tab=assessment/);
        expect(src).toMatch(/\/risks\/\$\{r\.riskId\}\?tab=assessment/);
        // risk-review keeps the plain overview root (distinct destination) —
        // `/risks/${r.id}` with no ?tab is unique to it.
        expect(src).toMatch(/\/risks\/\$\{r\.id\}`\)/);
        // Vendor renewal → the contract/renewal field anchor, distinct from
        // vendor-review's overview root.
        expect(src).toMatch(/\/vendors\/\$\{r\.id\}\?tab=overview#vendor-contract-renewal/);
        // Control exception expiry → the exceptions panel anchor.
        expect(src).toMatch(/\/controls\/\$\{r\.controlId\}#control-exceptions/);
        // Incident notification → the specific notification anchor, not the root.
        expect(src).toMatch(/\/incidents\/\$\{r\.incidentId\}#incident-notification-\$\{r\.id\}/);
    });

    it('the deep-link anchor targets exist on their detail pages', () => {
        // A deep-link to an anchor the page never renders scrolls nowhere.
        expect(
            read('src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx'),
        ).toMatch(/id="vendor-contract-renewal"/);
        expect(
            read('src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx'),
        ).toMatch(/id="control-exceptions"/);
        expect(
            read('src/app/t/[tenantSlug]/(app)/incidents/[incidentId]/page.tsx'),
        ).toMatch(/incident-notification-\$\{n\.id\}/);
        // The risk detail page honours ?tab= (so ?tab=assessment lands right).
        expect(
            read('src/app/t/[tenantSlug]/(app)/risks/[riskId]/page.tsx'),
        ).toMatch(/useSearchParams/);
    });
});

describe('6 — create-from-calendar is discoverable', () => {
    it('day cells carry a visible + affordance', () => {
        const src = read(MONTH);
        expect(src).toMatch(/calendar-day-add-/);
        expect(src).toMatch(/group-hover:opacity-100/);
        // Keyboard users get it too — hover-only would hide it from them.
        expect(src).toMatch(/focus-visible:opacity-100/);
        expect(src).toMatch(/newTaskLabel/);
    });

    it('the side panel offers an explicit create button', () => {
        const src = read(CLIENT);
        expect(src).toMatch(/calendar-new-task-on-day/);
        expect(src).toMatch(/newTaskOnDay/);
    });
});

describe('7 — off-screen deadlines are signposted', () => {
    it('probes for the next deadline when the range is empty', () => {
        const src = read(CLIENT);
        expect(src).toMatch(/nextOffscreenDeadline/);
        expect(src).toMatch(/data-testid="calendar-offscreen-hint"/);
        expect(src).toMatch(/calendar-jump-to-next/);
        // The probe must be conditional — it costs nothing on the normal
        // (non-empty) path.
        expect(src).toMatch(/isEmptyView \? CACHE_KEYS\.calendar\.range/);
    });

    it('the stale "Time" naming is gone from the badge surfaces', () => {
        for (const rel of [
            USECASE,
            'src/app/api/t/[tenantSlug]/calendar/upcoming-count/route.ts',
        ]) {
            expect(read(rel)).not.toMatch(/"Time" nav badge/);
        }
    });
});
