/**
 * THE SESSION LEDGER STEP: what a `managed-agents-session` SYNTHESIS step
 * records about one session (Step 5b of `docs/claude-managed-agents-design.md`).
 *
 * Its own module, with no imports beyond a type, so the two writers of these
 * steps write the SAME shape without the second loading the first's graph:
 *
 *   - the engine's settle (`execute.ts`), which records the session CREATED,
 *     then DELETED, DELETE_FAILED or KEPT;
 *   - the data-lifecycle reconciliation
 *     (`usecases/managed-agents-cleanup.ts`, #5843), which records DELETED
 *     when it deletes a session whose delete had failed.
 *
 * Ids and codes only, never content. The step is FAILED exactly when the
 * lifecycle is DELETE_FAILED, and that status (a plaintext column, where the
 * lifecycle sits in the encrypted `inputJson`) is what lets the reconciliation
 * find failed deletes without decrypting the whole ledger.
 */
import type { StepRecord } from '@/lib/agentic/drivers/step-recorder';

/** The label of the ledger step that records the session's lifecycle. */
export const SESSION_STEP_LABEL = 'managed-agents-session';

/** What the session step says happened to the session. */
export type SessionLifecycle = 'SESSION_CREATED' | 'SESSION_DELETED' | 'SESSION_KEPT' | 'SESSION_DELETE_FAILED';

/** The step record for one lifecycle event of one session. */
export function sessionStepRecord(lifecycle: SessionLifecycle, facts: Record<string, unknown>): StepRecord {
    return {
        status: lifecycle === 'SESSION_DELETE_FAILED' ? 'FAILED' : 'DONE',
        label: SESSION_STEP_LABEL,
        input: { lifecycle, ...facts },
    };
}
