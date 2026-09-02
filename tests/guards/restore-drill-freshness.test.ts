/**
 * The tripwire on the tripwire.
 *
 * `.github/workflows/restore-drill-freshness.yml` is the only thing in this
 * repository that knows the restore drill for this database lives in
 * `RodnaPamet/agri-saas`. If it is deleted, renamed, or quietly unscheduled,
 * the cross-repo dependency goes back to being invisible — which is the state
 * that let six consecutive scheduled failures pass unnoticed for five months.
 *
 * WHAT THIS GUARD CAN AND CANNOT SAY. It asserts SHAPE: the workflow exists,
 * is scheduled, names the right repo/workflow/leg, and has a notifier wired to
 * its failure. It CANNOT say a restore succeeded — that needs the network, and
 * a Jest guard reaching the GitHub API would make `Ratchets` non-hermetic and
 * fail PRs for facts unrelated to the diff.
 *
 * That division is the whole lesson of #2226. The retired
 * `tests/guards/oi-3-backup-restore.test.ts` held 38 green assertions about a
 * drill that never ran, because every one of them was about shape. Shape and
 * conduct need different instruments; this file is deliberately only one of
 * them, and says so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WF = '.github/workflows/restore-drill-freshness.yml';
const src = fs.readFileSync(path.join(ROOT, WF), 'utf8');

describe('restore-drill freshness workflow', () => {
    it('exists and is scheduled, not dispatch-only', () => {
        // A dispatch-only checker is one nobody runs. The drill it watches is
        // monthly; this must fire on its own.
        expect(src).toMatch(/^on:/m);
        expect(src).toMatch(/schedule:/);
        expect(src).toMatch(/cron:\s*'[^']+'/);
    });

    it('names the repository, workflow and MATRIX LEG it watches', () => {
        expect(src).toMatch(/DRILL_REPO:\s*RodnaPamet\/agri-saas/);
        expect(src).toMatch(/DRILL_WORKFLOW:\s*restore-test\.yml/);
        // The leg, specifically. That workflow is a `fail-fast: false` matrix
        // over `agrent` and `inflect-compliance`; its run-level conclusion is
        // `failure` if EITHER leg fails, so watching the run rather than the
        // job would report our database as broken when the other target broke,
        // and — worse — could report green off the other leg alone.
        expect(src).toMatch(/DRILL_LEG:\s*Restore Test \(inflect-compliance\)/);
        expect(src).toMatch(/actions\/runs\/\$\{id\}\/jobs/);
    });

    it('queries jobs with per_page in the QUERY STRING, not as a field', () => {
        // `gh api <path> -F per_page=100` returns HTTP 404 on the jobs
        // endpoint. Combined with a `|| continue` that 404 reads as "this run
        // has no successful leg" — an API error wearing the costume of a
        // negative result. Measured while building this; pinned so it cannot
        // come back.
        expect(src).toMatch(/jobs\?per_page=100/);
        expect(src).not.toMatch(/-F\s+per_page/);
    });

    it('fails closed on an unreadable API rather than reporting "stale"', () => {
        // The two outcomes need opposite responses: stale means act on the
        // backups, UNKNOWN means fix the observer. A check that collapses them
        // sends somebody to restore a database that is fine.
        expect(src).toMatch(/die\(\)\s*\{/);
        expect(src).toMatch(/NOT evidence the drill is stale/);
        // EVERY `gh api` call must be guarded. Asserting a fixed count instead
        // is what the first version of this test did, and it failed on a
        // correct workflow — the number of API calls is an implementation
        // detail, whereas "none of them may fall through" is the invariant.
        const ghCalls = (src.match(/gh api/g) ?? []).length;
        const guards = (src.match(/\|\|\s*die/g) ?? []).length;
        expect(ghCalls).toBeGreaterThanOrEqual(2);
        expect(guards).toBeGreaterThanOrEqual(ghCalls);
    });

    it('carries an explicit, justified staleness threshold', () => {
        const m = /MAX_AGE_DAYS:\s*'(\d+)'/.exec(src);
        expect(m).not.toBeNull();
        const days = Number(m![1]);
        // Above one monthly period plus slack, so a healthy month is never red
        // and alert fatigue never sets in; below two full misses, so a pattern
        // is caught. 45 also exceeds the 14-day snapshot retention: past it,
        // every snapshot the last success validated has already aged out.
        expect(days).toBeGreaterThan(31);
        expect(days).toBeLessThanOrEqual(60);
    });

    it('notifies off the WORKFLOW RUN conclusion, not from inside the script', () => {
        // The retired drill's alerting hung off a script's exit code, and the
        // run died at credential setup before that script was ever invoked —
        // so the alerting was downstream of the thing it was meant to detect.
        expect(src).toMatch(/notify-on-failure:/);
        expect(src).toMatch(/needs:\s*\[freshness\]/);
        // `cancelled()` too: a cancelled run observed nothing, which is not health.
        expect(src).toMatch(/if:\s*\$\{\{\s*failure\(\)\s*\|\|\s*cancelled\(\)\s*\}\}/);
    });

    it('declares issues: write at JOB level', () => {
        // Job permissions REPLACE the workflow block rather than merging, so a
        // workflow-level `contents: read` does not carry down and a notifier
        // without its own grant fails at the API call — silently, from the
        // perspective of anyone waiting to be told.
        const notifier = src.slice(src.indexOf('notify-on-failure:'));
        expect(notifier).toMatch(/permissions:\s*\n\s*issues:\s*write/);
    });

    it('comments on an existing issue rather than opening a new one each week', () => {
        const notifier = src.slice(src.indexOf('notify-on-failure:'));
        expect(notifier).toMatch(/issues\.createComment/);
        expect(notifier).toMatch(/issues\.create\(/);
        expect(notifier).toMatch(/state:\s*'open'/);
    });

    it('does not pretend to verify a restore itself', () => {
        // Self-limiting on purpose. If a future edit makes this file assert a
        // restore SUCCEEDED, it is claiming conduct from a source-text read —
        // the exact error that produced 38 green assertions over a dead drill.
        expect(src).not.toMatch(/restore (succeeded|passed|validated)/i);
    });
});
