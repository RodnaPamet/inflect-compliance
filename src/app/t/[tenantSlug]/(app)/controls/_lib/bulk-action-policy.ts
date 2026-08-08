/**
 * Which bulk actions a role may use on the Controls list.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE TERNARY
 * -----------------------------------------------
 * `delete` is ADMIN-only: `bulkDeleteControl` calls `assertCanAdmin`
 * server-side, so offering it to an EDITOR is a guaranteed 403. The rule
 * lived as `...(canAdmin ? [{ value: 'delete', … }] : [])` inside a 40-line
 * `useMemo` full of JSX — and the only thing guarding it was
 * `expect(src).toMatch(/value:\s*'delete'/)`, which matches the literal
 * INSIDE the ternary.
 *
 * So deleting the `canAdmin` guard, leaving the literal, kept CI green. The
 * gate had no test at all. Pulling the decision out makes it assertable per
 * role, which is what `tests/unit/controls-bulk-action-policy.test.ts` does.
 *
 * The rule mirrors the server. Every verb whose usecase asserts admin belongs
 * behind `canAdmin` here. Adding a bulk verb means deciding which list it
 * goes in — not appending to a JSX array and hoping a regex notices.
 */

/** Every bulk verb the Controls list can offer. */
export type ControlBulkAction = 'status' | 'assign' | 'delete';

/** Verbs whose usecase asserts ADMIN server-side. */
const ADMIN_ONLY: readonly ControlBulkAction[] = ['delete'];

/** Verbs any writer may use. */
const WRITER: readonly ControlBulkAction[] = ['status', 'assign'];

/**
 * The ordered action values available to a viewer.
 *
 * Order is the display order: the destructive verb last.
 */
export function controlBulkActionsFor(permissions: {
    canWrite: boolean;
    canAdmin?: boolean;
}): ControlBulkAction[] {
    // A reader has no bulk verbs at all — the bar should not appear.
    if (!permissions.canWrite) return [];
    return [...WRITER, ...(permissions.canAdmin ? ADMIN_ONLY : [])];
}

/** True when the verb is one the server will reject for a non-admin. */
export function isAdminOnlyBulkAction(action: ControlBulkAction): boolean {
    return ADMIN_ONLY.includes(action);
}
