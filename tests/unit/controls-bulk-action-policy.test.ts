/**
 * Which bulk verbs each role may use on the Controls list.
 *
 * This gate had NO test. `bulkDeleteControl` calls `assertCanAdmin`
 * server-side, so offering `delete` to an EDITOR is a guaranteed 403 — and
 * the only thing guarding the client rule was
 * `expect(src).toMatch(/value:\s*'delete'/)` in
 * tests/guardrails/bulk-delete-coverage.test.ts, which matched the literal
 * INSIDE the `canAdmin ? [...] : []` ternary. Delete the guard, leave the
 * literal, CI stays green.
 *
 * All three bulk mutations were covered only by regex. These are the
 * behavioural assertions.
 */
import {
    controlBulkActionsFor,
    isAdminOnlyBulkAction,
    type ControlBulkAction,
} from '@/app/t/[tenantSlug]/(app)/controls/_lib/bulk-action-policy';

/** The four role shapes the Controls page can be rendered with. */
const OWNER = { canWrite: true, canAdmin: true };
const ADMIN = { canWrite: true, canAdmin: true };
const EDITOR = { canWrite: true, canAdmin: false };
const READER = { canWrite: false, canAdmin: false };

describe('bulk action set per role', () => {
    it('OWNER and ADMIN get every verb, including delete', () => {
        for (const [name, perms] of [['OWNER', OWNER], ['ADMIN', ADMIN]] as const) {
            const actions = controlBulkActionsFor(perms);
            expect({ name, actions }).toEqual({
                name,
                actions: ['status', 'assign', 'delete'],
            });
        }
    });

    it('EDITOR keeps status and assign but NOT delete', () => {
        // The defect this file exists for: an editor offered `delete` gets a
        // 403 from a button the UI presented as available.
        const actions = controlBulkActionsFor(EDITOR);
        expect(actions).toEqual(['status', 'assign']);
        expect(actions).not.toContain('delete');
    });

    it('READER gets no bulk verbs at all', () => {
        // A reader cannot mutate anything, so the bar has nothing to offer.
        expect(controlBulkActionsFor(READER)).toEqual([]);
    });

    it('treats a missing canAdmin as not-admin', () => {
        // `canAdmin?: boolean` — an absent flag must not read as permission.
        expect(controlBulkActionsFor({ canWrite: true })).toEqual(['status', 'assign']);
    });

    it('puts the destructive verb last', () => {
        // Display order, asserted so a reorder is deliberate.
        const actions = controlBulkActionsFor(ADMIN);
        expect(actions[actions.length - 1]).toBe('delete');
    });
});

describe('admin-only classification', () => {
    it('marks delete as admin-only and the others as not', () => {
        expect(isAdminOnlyBulkAction('delete')).toBe(true);
        expect(isAdminOnlyBulkAction('status')).toBe(false);
        expect(isAdminOnlyBulkAction('assign')).toBe(false);
    });

    it('every admin-only verb is absent from the EDITOR set', () => {
        // The invariant, rather than a list that could drift: whatever is
        // classified admin-only must not reach a non-admin.
        const editorActions = controlBulkActionsFor(EDITOR);
        const all: ControlBulkAction[] = ['status', 'assign', 'delete'];
        for (const action of all) {
            if (isAdminOnlyBulkAction(action)) {
                expect(editorActions).not.toContain(action);
            }
        }
    });

    it('every verb an admin gets is either writer-level or admin-only', () => {
        // Guards against a verb being added to the admin set without being
        // classified — which is how `delete` ended up unguarded in the first
        // place.
        for (const action of controlBulkActionsFor(ADMIN)) {
            const writerHasIt = controlBulkActionsFor(EDITOR).includes(action);
            expect(writerHasIt || isAdminOnlyBulkAction(action)).toBe(true);
        }
    });
});
