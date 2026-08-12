/**
 * Tasks roadmap TP-6 (P4.7) — no-swallowed-mutation ratchet.
 *
 * The task detail page and the create-task form fire a fistful of
 * `fetch(...)` mutations (assign, reviewer, link, comment, status,
 * watch, pending-link-attach). Before TP-6 several of them were
 * fire-and-forget: they never inspected `res.ok`, so a 4xx/5xx was
 * swallowed and the UI reported success while nothing changed
 * server-side (the assign snapped back; the create-form dropped a
 * link, leaving an AUDIT_FINDING task later un-closable).
 *
 * B3-3 — the detail page's half of this guard was RETIRED. It listed
 * eight handler NAMES and asserted each body matched
 * `if (!<name>Res.ok)` plus a `toast.error`/`throw`. Two problems:
 *
 *   • It pinned a spelling, not a behaviour. B3-4 moved the ok-check
 *     into `okOrThrow` + `useTenantMutation`'s `mutationFn` — the
 *     failure is surfaced strictly better, and seven of the sixteen
 *     assertions went red for a refactor that fixed nothing.
 *   • It never executed the page, so it stayed green through a handler
 *     that read `res.ok` and then did nothing useful with it.
 *
 * Its replacement is `tests/rendered/task-detail-mutation-failures.test.tsx`,
 * which mounts the real page and asserts the user-visible contract: a
 * rejected write surfaces the SERVER'S reason, a rejected comment does
 * not clear the box, and a successful write reaches the list + KPI
 * caches this page never reads.
 *
 * What survives here is the part that is genuinely structural and that
 * no rendered test can cover cheaply: the empty-`.catch` swallow scan
 * (a whole-file check, immune to the handler-shape churn above) and the
 * create-form's pending-link contract, whose file B3-4 did not touch.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DETAIL_PAGE = path.join(
    REPO_ROOT,
    'src/app/t/[tenantSlug]/(app)/tasks/[taskId]/page.tsx',
);
const NEW_TASK_FORM = path.join(
    REPO_ROOT,
    'src/app/t/[tenantSlug]/(app)/tasks/_form/useNewTaskForm.ts',
);

function read(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

describe('TP-6 — task detail mutations are never silently swallowed', () => {
    const src = read(DETAIL_PAGE);

    it('has no empty fire-and-forget .catch swallow', () => {
        // `res.json().catch(() => ({}))` is a legitimate parse fallback;
        // an empty `.catch(() => {})` / `.catch(() => {/* … */})` on a
        // mutation is the swallow anti-pattern this ratchet bans.
        expect(src).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*(\/\*[^*]*\*\/\s*)?\}\s*\)/);
    });
});

describe('TP-6 — create-form pending-link failures are not swallowed', () => {
    const src = read(NEW_TASK_FORM);

    it('no longer carries the best-effort swallow comment', () => {
        expect(src).not.toMatch(/swallow\s+—\s+link is best-effort/i);
        expect(src).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*(\/\*[^*]*\*\/\s*)?\}\s*\)/);
    });

    it('collects failed links and surfaces them without trapping the user', () => {
        // The link loop must inspect each response and surface any failure.
        expect(src).toMatch(/failedLinks/);
        expect(src).toMatch(/if\s*\(\s*!\s*linkRes\.ok\s*\)/);
        // A toast of EITHER severity counts as surfacing. The partial case
        // uses `warning`, not `error`: the task itself was created.
        expect(src).toMatch(/toast\.(error|warning)\(/);

        // It must NOT throw on the partial-success path. Throwing kept the
        // modal open over an ALREADY-CREATED task with a submittable form
        // and no route to it, so pressing the button again minted a
        // duplicate. The flow now completes through `onSuccess`, which
        // closes the modal and navigates to the new task — the page where
        // the missing links can actually be added.
        const partialBlock = src.slice(
            src.indexOf('if (failedLinks.length > 0)'),
        );
        const partialEnd = partialBlock.indexOf('telemetry.trackSuccess');
        expect(partialEnd).toBeGreaterThan(-1);
        const partialBody = partialBlock.slice(0, partialEnd);
        expect(partialBody).not.toMatch(/throw\s+new\s+Error/);
        expect(partialBlock).toMatch(/onSuccess\(task\)/);

        // The hard-failure path (create itself failed) still throws.
        expect(src).toMatch(/throw\s+new\s+Error/);
    });
});
