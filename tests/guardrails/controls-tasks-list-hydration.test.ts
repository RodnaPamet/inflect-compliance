/**
 * Hydration-fetch ratchet for the controls + tasks list pages.
 *
 * The SSR path returns the initial list, hydrates the client, and
 * the client's `useQuery` is supposed to honour that payload until
 * `staleTime` elapses. If `initialDataUpdatedAt` is set to `0` (or
 * `staleTime` is unset on controls), React Query treats the SSR data
 * as instantly stale and fires a duplicate `GET /controls` /
 * `GET /tasks` on hydration. Both pages also narrow the
 * server-side `_count` aggregate to the two keys the list view
 * actually reads — bloating it back to six is a silent perf
 * regression.
 *
 * This guardrail catches all three regressions structurally so
 * future refactors can't reintroduce them without an explicit diff.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('list-page hydration shape', () => {
    const controlsClient = read(
        'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
    );
    const tasksClient = read(
        'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx',
    );

    test('ControlsClient gates fallbackData on filtersMatchInitial (SWR migration, Wave 2)', () => {
        // Wave 2 migrated ControlsClient from React Query to
        // `useTenantSWR`. The prior `initialDataUpdatedAt:
        // filtersMatchInitial ? Date.now() : 0` + `staleTime` shape became
        // `fallbackData: filtersMatchInitial ? { rows: initialControls,
        // truncated: false } : undefined` — the same SSR-honouring gate the
        // already-migrated TasksClient uses (below). Pin the gate predicate
        // AND the wrapped CappedList shape.
        //
        // The deleted-view (admin Restore/Purge) added a `?includeDeleted=true`
        // fetch whose route returns a bare array, so the SWR type widened to a
        // union and the fallback additionally excludes the deleted view
        // (`&& !showDeleted`) — a stricter gate. Accept both, still requiring
        // the CappedList shape and the filtersMatchInitial predicate.
        expect(controlsClient).toMatch(
            /useTenantSWR<CappedList<ControlListItem>(\s*\|\s*ControlListItem\[\])?>/,
        );
        expect(controlsClient).toMatch(
            /fallbackData:\s*filtersMatchInitial(\s*&&\s*!showDeleted)?\s*\?\s*\{\s*rows:\s*initialControls,\s*truncated:\s*false\s*\}/,
        );
    });

    test('TasksClient gates fallbackData on filtersMatchInitial + tunes dedupingInterval (Epic 69)', () => {
        // Epic 69 migrated TasksClient from React Query to
        // `useTenantSWR`. The prior `initialData: filtersMatchInitial
        // ? initialTasks : undefined` shape became `fallbackData:
        // filtersMatchInitial ? initialTasks : undefined`. PR-9 then
        // wrapped the cache value as `CappedList<TaskListItem>`
        // (mirroring the package shape change from PR-5), so the
        // fallback now constructs `{ rows: initialTasks, truncated:
        // false }`. Pin both halves: the gate predicate AND the
        // wrapped-shape construction.
        //
        // The tasks Deleted view then added a `?includeDeleted=true` fetch,
        // so the fallback additionally excludes that view (`&& !showDeleted`)
        // — the SSR payload only ever holds LIVE rows, and seeding it into
        // the deleted view would briefly show active tasks under a "Deleted"
        // heading. Same widening the ControlsClient assertion above already
        // carries, for the same reason. Accept both, still requiring the
        // CappedList shape and the filtersMatchInitial predicate.
        expect(tasksClient).toMatch(
            /fallbackData:\s*filtersMatchInitial(\s*&&\s*!showDeleted)?\s*\?\s*\{\s*rows:\s*initialTasks,\s*truncated:\s*false\s*\}/,
        );
        expect(tasksClient).toMatch(/dedupingInterval:\s*30_000/);
    });

    test('neither client uses the regression shape `initialDataUpdatedAt: 0` standalone', () => {
        // The literal "initialDataUpdatedAt: 0," with no ternary is the
        // pre-fix shape. Allow it to appear only inside the ternary fallback.
        const badShape = /initialDataUpdatedAt:\s*0\s*[,\n}]/;
        expect(controlsClient).not.toMatch(badShape);
        expect(tasksClient).not.toMatch(badShape);
    });
});

describe('ControlRepository list `_count` projection', () => {
    const repo = read('src/app-layer/repositories/ControlRepository.ts');

    // Both `list()` and `listPaginated()` feed the same client surface.
    // ControlsClient renders `_count?.evidenceLinks` (+ `evidence`); the
    // Tasks column reads the unified `taskTotal`/`taskDone` fields
    // `listControls` attaches (the legacy `_count.controlTasks` relation
    // was removed in TP-2). Fetching the other four (`risks`, `assets`,
    // `contributors`, and the now-gone `controlTasks`) costs a correlated
    // subquery per row and the values are dropped. Lock the projection.
    //
    // PR-3 hoisted the list-shape into a shared `controlListSelect`
    // constant referenced by both functions, so the literal now
    // appears once at module scope rather than twice in line. The
    // anti-bloat invariant (only the two consumed keys) is unchanged.
    // R2-P4 — the list Evidence column sums links + Evidence-entity links
    // (to agree with the detail badge). EP-3 dropped the singular
    // `Evidence.controlId` (→ the `EvidenceControlLink` join), so the second
    // consumed key is now `evidenceControlLinks`, not `evidence`. The
    // invariant is still "only the consumed keys".
    const ALLOWED = /_count:\s*\{\s*select:\s*\{\s*evidenceLinks:\s*true,\s*evidenceControlLinks:\s*true\s*\}\s*\}/g;

    test('list-shape exposes only the consumed _count keys (evidenceLinks + evidenceControlLinks)', () => {
        const matches = repo.match(ALLOWED) ?? [];
        // One declaration in the shared `controlListSelect` constant.
        expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    test('list-shape constant is referenced by list() and listPaginated()', () => {
        // The performance fix only sticks if both list paths actually
        // reach the trimmed shape. PR-3 introduced a shared constant —
        // pin its name so a future refactor can't drop one reference.
        const listFnIndex = repo.indexOf('static async list(');
        const detailIndex = repo.indexOf('static async getById(');
        const listSection = repo.slice(listFnIndex, detailIndex);
        const refs = listSection.match(/controlListSelect/g) ?? [];
        expect(refs.length).toBe(2);
    });

    test('no list-shape _count includes the unused four keys', () => {
        // `getById` (detail read) intentionally keeps the wider _count
        // because the detail page renders all four. Scope this check to
        // the list-shape constant + the two list functions, slicing
        // before `getById`.
        const listSection = repo.slice(0, repo.indexOf('static async getById('));
        expect(listSection).not.toMatch(/contributors:\s*true/);
        expect(listSection).not.toMatch(/assets:\s*true/);
        // `evidence: true` and `risks: true` are also dropped — but both
        // names recur as relations elsewhere, so assert via the known-bad
        // wide-shape literal instead.
        expect(listSection).not.toMatch(
            /_count:\s*\{\s*select:\s*\{\s*evidence:\s*true,\s*risks:\s*true,\s*assets:\s*true/,
        );
    });
});
