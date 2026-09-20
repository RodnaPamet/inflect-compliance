/**
 * Event-driven TASK_DUE notification wiring ratchet.
 *
 * #592 shipped in-app task-due notifications as a daily 08:00 cron
 * only. That made them invisible whenever the scheduler had not
 * registered the repeatable, and it never fired for a task created
 * after 08:00 on its own due day. The follow-up wired the
 * notification into the task usecases so a near-term deadline
 * reaches the bell the instant a task is created / rescheduled /
 * assigned.
 *
 * This ratchet locks that wiring in — and locks the two structural
 * fixes the rollout needed:
 *   - the shared helper lives in `notifications/`, NOT `jobs/`, so
 *     the task usecase (an HTTP request path) never imports the job
 *     module graph;
 *   - the insert is a `createMany` + `skipDuplicates`, never a
 *     `create`, so a duplicate dedupeKey can't throw P2002 and
 *     poison the caller's transaction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

const SHARED = read('src/app-layer/notifications/task-due.ts');
const JOB = read('src/app-layer/jobs/task-due-notification.ts');
const TASK_USECASE = read('src/app-layer/usecases/task.ts');

describe('TASK_DUE notification — event-driven wiring', () => {
    it('the shared helper lives in notifications/, not jobs/', () => {
        expect(SHARED).toMatch(
            /export async function createTaskDueNotification\b/,
        );
    });

    it('the helper is idempotent — mints the dedupeKey', () => {
        expect(SHARED).toMatch(/buildTaskDueDedupeKey\(/);
    });

    it('the duplicate insert never throws — createMany + skipDuplicates', () => {
        // A `create` would throw P2002 on a duplicate dedupeKey;
        // thrown inside an interactive transaction it poisons the
        // whole transaction. `createMany` + `skipDuplicates` compiles
        // to ON CONFLICT DO NOTHING and returns count 0 instead.
        expect(SHARED).toMatch(/notification\.createMany\(/);
        expect(SHARED).toMatch(/skipDuplicates:\s*true/);
        expect(SHARED).not.toMatch(/notification\.create\(/);
    });

    it('the cron job consumes the shared helper', () => {
        expect(JOB).toMatch(
            /import \{[\s\S]*?createTaskDueNotification[\s\S]*?\} from ['"]\.\.\/notifications\/task-due['"]/,
        );
    });

    it('the task usecase imports the helper from notifications/, not jobs/', () => {
        // Load-bearing: a usecase importing from jobs/ couples the
        // HTTP request path to the job module graph.
        expect(TASK_USECASE).toMatch(
            /import \{ createTaskDueNotification \} from ['"]\.\.\/notifications\/task-due['"]/,
        );
        expect(TASK_USECASE).not.toMatch(/from ['"]\.\.\/jobs\//);
    });

    it('createTask, updateTask and assignTask each emit the notification', () => {
        const callSites =
            TASK_USECASE.match(/emitTaskDueNotification\(ctx, result\)/g) ??
            [];
        expect(callSites.length).toBe(3);
    });

    it('the emit wrapper runs outside the task transaction', () => {
        // It takes `ctx` (not the transaction `db`) and opens its own
        // `runInTenantContext` — a notification failure must never
        // roll back the task write.
        expect(TASK_USECASE).toMatch(
            /async function emitTaskDueNotification\(\s*ctx: RequestContext,/,
        );
    });
});
