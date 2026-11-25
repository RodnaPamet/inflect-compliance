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

/**
 * HOW LONG A PAUSED RUN'S SESSION WAITS FOR A PERSON (#5854, the owner's
 * second decision of 2026-11-25). The SIGTERM drain leaves a paused run's
 * session open, so that a person's resume reconnects to it and answers its
 * open calls rather than starting the run over. The data-lifecycle
 * reconciliation leaves the session alone while the run has been PAUSED for
 * less than this (measured from the run's last change, which is the pause),
 * and settles it as an abandoned one (deleted, or recorded kept where the
 * connection keeps sessions) once it has been PAUSED longer. A resume after
 * that is refused by name (`managed_agents_reconnect_session_settled_while_paused`).
 *
 * Twenty-four hours: a rolling deploy at any hour leaves the next working day
 * to notice and resume, and the reconciliation runs once a day (03:00 UTC),
 * so the session is gone at most a day after that. It is a source constant,
 * not a tenant setting: how long a conversation is kept in a customer's
 * workspace is not a value a workspace administrator moves.
 */
export const PAUSED_SESSION_HOLD_HOURS = 24;
export const PAUSED_SESSION_HOLD_MS = PAUSED_SESSION_HOLD_HOURS * 60 * 60 * 1000;

/**
 * HOW LATE A RESUME MAY STILL RECONNECT: an hour inside the hold. The resume
 * and the reconciliation decide from the same fact, the instant the run was
 * paused (its row's `updatedAt`), each against its own clock. A resume claimed
 * within this window reconnects; one claimed later refuses the run by name and
 * settles the session itself; the reconciliation settles a session only once
 * the run has been PAUSED for the whole hold. The hour between them absorbs
 * clock skew between hosts and the time a pass takes between its read and its
 * delete, so a session one of them reconnects to is never one the other
 * deletes.
 */
export const PAUSED_SESSION_RESUME_WINDOW_MS = PAUSED_SESSION_HOLD_MS - 60 * 60 * 1000;
