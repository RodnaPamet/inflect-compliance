/**
 * Audit Coherence S8 (2026-05-24) — pure-function unit tests for
 * the work-item state machine + transition checker.
 *
 * No DB, no usecase plumbing — these tests pin the legal-graph
 * shape so a future PR can't quietly widen or narrow the machine
 * without an explicit assertion change.
 */
import {
    TASK_TRANSITIONS,
    checkTaskTransition,
    formatTransitionError,
    isTerminalStatus,
    isActiveStatus,
    ALL_TASK_STATUSES,
    TASK_STATUS_DISPLAY_NAMES,
} from '@/app-layer/domain/task-status';

describe('TASK_TRANSITIONS — legal graph', () => {
    it('exposes a key per TaskStatus value', () => {
        for (const s of ALL_TASK_STATUSES) {
            expect(TASK_TRANSITIONS).toHaveProperty(s);
        }
        expect(Object.keys(TASK_TRANSITIONS).length).toBe(
            ALL_TASK_STATUSES.length,
        );
    });

    it('terminal statuses (CLOSED, CANCELED) have an empty out-set', () => {
        expect(TASK_TRANSITIONS.CLOSED.size).toBe(0);
        expect(TASK_TRANSITIONS.CANCELED.size).toBe(0);
    });

    it('OPEN can short-circuit to RESOLVED or CANCELED', () => {
        const out = TASK_TRANSITIONS.OPEN;
        expect(out.has('RESOLVED')).toBe(true);
        expect(out.has('CANCELED')).toBe(true);
        expect(out.has('TRIAGED')).toBe(true);
    });

    it('RESOLVED can go to CLOSED or re-open to IN_PROGRESS', () => {
        const out = TASK_TRANSITIONS.RESOLVED;
        expect(out.has('CLOSED')).toBe(true);
        expect(out.has('IN_PROGRESS')).toBe(true);
        // RESOLVED → OPEN is intentionally illegal — re-opening goes
        // through IN_PROGRESS to keep the lifecycle forward-moving.
        expect(out.has('OPEN')).toBe(false);
    });
});

describe('checkTaskTransition', () => {
    it('returns null on a legal transition', () => {
        expect(checkTaskTransition('OPEN', 'TRIAGED')).toBeNull();
        expect(checkTaskTransition('IN_PROGRESS', 'RESOLVED')).toBeNull();
        expect(checkTaskTransition('RESOLVED', 'CLOSED')).toBeNull();
    });

    it('flags a no-op (same status) as a precise error variant', () => {
        const err = checkTaskTransition('IN_PROGRESS', 'IN_PROGRESS');
        expect(err).toEqual({ kind: 'no_op', status: 'IN_PROGRESS' });
    });

    it('flags an illegal transition between two known statuses', () => {
        const err = checkTaskTransition('CLOSED', 'OPEN');
        expect(err).toEqual({ kind: 'illegal', from: 'CLOSED', to: 'OPEN' });
    });

    it('flags CANCELED as a hard terminal — no transitions out', () => {
        for (const s of ALL_TASK_STATUSES) {
            if (s === 'CANCELED') continue;
            const err = checkTaskTransition('CANCELED', s);
            expect(err?.kind).toBe('illegal');
        }
    });

    it('flags an unknown from-status', () => {
        const err = checkTaskTransition('NEW', 'OPEN');
        expect(err).toEqual({ kind: 'unknown_from', from: 'NEW' });
    });

    it('flags an unknown to-status', () => {
        const err = checkTaskTransition('OPEN', 'DONE_DONE');
        expect(err).toEqual({ kind: 'unknown_to', to: 'DONE_DONE' });
    });
});

describe('formatTransitionError', () => {
    it('renders a precise message for every error kind', () => {
        // The message reaches the user verbatim as the refusal's reason,
        // so statuses are named as the UI names them — never the enum
        // value, and never the internal word "work-item".
        expect(formatTransitionError({ kind: 'no_op', status: 'IN_PROGRESS' })).toBe(
            'The task is already In Progress.',
        );
        expect(
            formatTransitionError({ kind: 'illegal', from: 'TRIAGED', to: 'OPEN' }),
        ).toBe('A task cannot move from Triaged to Open.');
        expect(
            formatTransitionError({ kind: 'unknown_from', from: 'NEW' }),
        ).toMatch(/Unknown current status "NEW"/);
        expect(
            formatTransitionError({ kind: 'unknown_to', to: 'DONE_DONE' }),
        ).toMatch(/Unknown target status "DONE_DONE"/);
    });
});

describe('TASK_STATUS_DISPLAY_NAMES — the names server refusals use', () => {
    it('names every status exactly as the UI labels it (en.json tasks.statusLabels)', () => {
        const en = require('../../../messages/en.json') as {
            tasks: { statusLabels: Record<string, string> };
        };
        expect(TASK_STATUS_DISPLAY_NAMES).toEqual(en.tasks.statusLabels);
        expect(Object.keys(TASK_STATUS_DISPLAY_NAMES).sort()).toEqual(
            [...ALL_TASK_STATUSES].sort(),
        );
    });
});

describe('isTerminalStatus / isActiveStatus — terminal/active partitioning', () => {
    it('partitions ALL_TASK_STATUSES cleanly', () => {
        for (const s of ALL_TASK_STATUSES) {
            // Every status is exactly one of terminal or active —
            // never both, never neither.
            const t = isTerminalStatus(s);
            const a = isActiveStatus(s);
            expect(t !== a).toBe(true);
        }
    });

    it('classifies the three terminal statuses', () => {
        expect(isTerminalStatus('RESOLVED')).toBe(true);
        expect(isTerminalStatus('CLOSED')).toBe(true);
        expect(isTerminalStatus('CANCELED')).toBe(true);
    });
});
