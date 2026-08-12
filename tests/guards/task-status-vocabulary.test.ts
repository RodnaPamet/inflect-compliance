/**
 * Tasks roadmap TP-1 — task status vocabulary ratchet.
 *
 * Locks three invariants that used to drift across the codebase:
 *
 *   (a) The shared status→badge map (`src/lib/task-status-badge.ts`)
 *       has EXACTLY the eight `TaskStatus` enum values — no phantom
 *       "DONE", the spelling is "CANCELED" (one L), and every entry
 *       carries a valid `<StatusBadge>` variant + a `labelKey`.
 *
 *   (b) The task renderers consume that shared map and do NOT redeclare
 *       their own inline status→variant object (the old divergence: some
 *       had `OPEN: 'warning'`, others `OPEN: 'neutral'`; some carried a
 *       "DONE" tone or the two-L "CANCELLED" spelling).
 *
 *   (c) The Tasks list STATUS filter offers EXACTLY the eight enum
 *       values — including the real `IN_REVIEW` (TP-2), `TRIAGED`, and
 *       `BLOCKED` states.
 *
 * All three read the LIVE sources / schema, so a regression that
 * re-inlines a map, adds a "DONE"/"CANCELLED" spelling, or desyncs the
 * filter from the enum fails CI.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { TASK_STATUS_BADGE } from '@/lib/task-status-badge';

const ROOT = join(__dirname, '..', '..');

/**
 * Canonical enum values, parsed from the live Prisma schema.
 *
 * Members are matched positively (`SCREAMING_SNAKE` only) rather than by
 * subtracting the things that are not members. B3-6 put an
 * `@@map("WorkItemStatus")` block attribute inside this enum — pinning
 * the physical Postgres type so the rename needed no migration — and a
 * blank-and-comment-subtracting parser read that attribute line as a
 * ninth status value.
 */
function parseTaskStatusEnum(): string[] {
    const schema = readFileSync(
        join(ROOT, 'prisma', 'schema', 'enums.prisma'),
        'utf8',
    );
    const match = schema.match(/enum\s+TaskStatus\s*\{([^}]*)\}/);
    if (!match) throw new Error('TaskStatus enum not found in enums.prisma');
    return match[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[A-Z][A-Z0-9_]*$/.test(l));
}

const ENUM_VALUES = parseTaskStatusEnum();
const ALLOWED_VARIANTS = new Set([
    'success',
    'info',
    'neutral',
    'warning',
    'error',
]);

// The four renderers the map is meant to unify. Each MUST import the
// shared module and MUST NOT redeclare a local status→variant map.
const RENDERERS: Record<string, string> = {
    LinkedTasksPanel: 'src/components/LinkedTasksPanel.tsx',
    ControlTaskRows: 'src/components/controls-shared/ControlTaskRows.tsx',
    TaskEditPanel: 'src/components/controls-shared/TaskEditPanel.tsx',
    TasksClient: 'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx',
};

function read(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

describe('TP-1 (a) — the shared TASK_STATUS_BADGE map', () => {
    test('has exactly the eight TaskStatus keys', () => {
        expect(new Set(Object.keys(TASK_STATUS_BADGE))).toEqual(
            new Set(ENUM_VALUES),
        );
        expect(Object.keys(TASK_STATUS_BADGE)).toHaveLength(8);
    });

    test('spelling is CANCELED (one L), and there is no DONE', () => {
        const keys = Object.keys(TASK_STATUS_BADGE);
        expect(keys).toContain('CANCELED');
        expect(keys).not.toContain('CANCELLED');
        expect(keys).not.toContain('DONE');
    });

    test('every entry has a valid StatusBadge variant + a labelKey', () => {
        for (const [status, spec] of Object.entries(TASK_STATUS_BADGE)) {
            expect(ALLOWED_VARIANTS.has(spec.variant)).toBe(true);
            expect(typeof spec.labelKey).toBe('string');
            expect(spec.labelKey.length).toBeGreaterThan(0);
            // sanity: the key names the status it belongs to
            expect(spec.labelKey).toContain(status);
        }
    });

    test('OPEN is the one consistent open tone (neutral) and BLOCKED is the only error tone', () => {
        expect(TASK_STATUS_BADGE.OPEN.variant).toBe('neutral');
        const errorStatuses = Object.entries(TASK_STATUS_BADGE)
            .filter(([, spec]) => spec.variant === 'error')
            .map(([k]) => k);
        expect(errorStatuses).toEqual(['BLOCKED']);
    });
});

describe('TP-1 (b) — renderers consume the shared map, no inline status→variant map', () => {
    for (const [name, rel] of Object.entries(RENDERERS)) {
        test(`${name} imports the shared task-status-badge module`, () => {
            const src = read(rel);
            expect(src).toMatch(/from\s+['"]@\/lib\/task-status-badge['"]/);
            expect(src).toMatch(/taskStatusVariant\s*\(/);
        });

        test(`${name} does not redeclare an inline status→variant object`, () => {
            const src = read(rel);
            // A local const/let/var named like a status map, assigned an
            // object literal. The shared-module import + call sites never
            // match `<NAME> ... = {`.
            const inlineStatusMap =
                /(?:const|let|var)\s+\w*STATUS\w*(?::[^=\n]*)?\s*=\s*\{/;
            expect(src).not.toMatch(inlineStatusMap);
        });

        test(`${name} carries no "DONE" tone or two-L "CANCELLED" spelling`, () => {
            const src = read(rel);
            expect(src).not.toMatch(/CANCELLED/);
            expect(src).not.toMatch(/\bDONE\b/);
        });
    }
});

describe('TP-1 (c) — the Tasks list STATUS filter equals the enum set', () => {
    test('filter-defs status options are exactly the TaskStatus values', () => {
        const src = read('src/app/t/[tenantSlug]/(app)/tasks/filter-defs.ts');
        const filterStatuses = new Set(
            [...src.matchAll(/filterEnums\.status\.(\w+)/g)].map((m) => m[1]),
        );
        expect(filterStatuses).toEqual(new Set(ENUM_VALUES));
        // IN_REVIEW is now a real reviewer-sign-off state (TP-2); TRIAGED +
        // BLOCKED remain real states.
        expect(filterStatuses.has('IN_REVIEW')).toBe(true);
        expect(filterStatuses.has('TRIAGED')).toBe(true);
        expect(filterStatuses.has('BLOCKED')).toBe(true);
    });
});
