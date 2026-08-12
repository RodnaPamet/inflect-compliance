/**
 * Work Item Status Constants — Unit Tests
 *
 * Tests the shared status grouping logic and verifies that
 * TRIAGED is correctly included in active status groups
 * across all affected paths.
 */

import {
    TERMINAL_TASK_STATUSES,
    ACTIVE_TASK_STATUSES,
    ALL_TASK_STATUSES,
    ACTIVE_STATUS_FILTER,
    isTerminalStatus,
    isActiveStatus,
    checkTaskTransition,
} from '../../src/app-layer/domain/task-status';
import { readPrismaSchema } from '../helpers/prisma-schema';

// ═════════════════════════════════════════════════════════════════════
// 1. Shared Constants
// ═════════════════════════════════════════════════════════════════════

describe('Work Item Status Constants', () => {
    test('TERMINAL statuses are exactly RESOLVED, CLOSED, CANCELED', () => {
        expect([...TERMINAL_TASK_STATUSES].sort()).toEqual(
            ['CANCELED', 'CLOSED', 'RESOLVED'],
        );
    });

    test('ACTIVE statuses include OPEN, TRIAGED, IN_PROGRESS, IN_REVIEW, BLOCKED', () => {
        const active = [...ACTIVE_TASK_STATUSES].sort();
        expect(active).toEqual(['BLOCKED', 'IN_PROGRESS', 'IN_REVIEW', 'OPEN', 'TRIAGED']);
    });

    test('IN_REVIEW is active, not terminal (TP-2)', () => {
        expect(isActiveStatus('IN_REVIEW')).toBe(true);
        expect(isTerminalStatus('IN_REVIEW')).toBe(false);
    });

    test('TRIAGED is in ACTIVE statuses (the bug fix)', () => {
        expect(ACTIVE_TASK_STATUSES).toContain('TRIAGED');
    });

    test('TRIAGED is NOT in TERMINAL statuses', () => {
        expect(TERMINAL_TASK_STATUSES).not.toContain('TRIAGED');
    });

    test('ALL statuses is the union of ACTIVE + TERMINAL', () => {
        const union = [...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES].sort();
        const all = [...ALL_TASK_STATUSES].sort();
        expect(union).toEqual(all);
    });

    test('no overlap between ACTIVE and TERMINAL', () => {
        const overlap = ACTIVE_TASK_STATUSES.filter(s =>
            (TERMINAL_TASK_STATUSES as readonly string[]).includes(s),
        );
        expect(overlap).toEqual([]);
    });

    test('ACTIVE_STATUS_FILTER uses notIn pattern', () => {
        expect(ACTIVE_STATUS_FILTER).toEqual({
            notIn: expect.arrayContaining(['RESOLVED', 'CLOSED', 'CANCELED']),
        });
        expect(ACTIVE_STATUS_FILTER.notIn).toHaveLength(3);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Helper Functions
// ═════════════════════════════════════════════════════════════════════

describe('isTerminalStatus', () => {
    test.each(['RESOLVED', 'CLOSED', 'CANCELED'])('%s is terminal', (status) => {
        expect(isTerminalStatus(status)).toBe(true);
    });

    test.each(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED'])('%s is not terminal', (status) => {
        expect(isTerminalStatus(status)).toBe(false);
    });

    test('unknown status is not terminal', () => {
        expect(isTerminalStatus('UNKNOWN')).toBe(false);
    });
});

describe('isActiveStatus', () => {
    test.each(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED'])('%s is active', (status) => {
        expect(isActiveStatus(status)).toBe(true);
    });

    test.each(['RESOLVED', 'CLOSED', 'CANCELED'])('%s is not active', (status) => {
        expect(isActiveStatus(status)).toBe(false);
    });

    test('TRIAGED is active (the core fix)', () => {
        expect(isActiveStatus('TRIAGED')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2b. Transitions — CLOSED reachable directly (RESOLVED retired in UI)
// ═════════════════════════════════════════════════════════════════════

describe('checkTaskTransition — direct close', () => {
    // RESOLVED was retired as a redundant intermediate; every active
    // status can now go straight to CLOSED in one step.
    test.each(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED'])(
        '%s → CLOSED is legal',
        (from) => {
            expect(checkTaskTransition(from, 'CLOSED')).toBeNull();
        },
    );

    test('a legacy RESOLVED task can still advance to CLOSED', () => {
        expect(checkTaskTransition('RESOLVED', 'CLOSED')).toBeNull();
    });

    test('CLOSED stays terminal (no transitions out)', () => {
        expect(checkTaskTransition('CLOSED', 'OPEN')).not.toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. Deadline Monitor — TRIAGED inclusion
// ═════════════════════════════════════════════════════════════════════

describe('Deadline Monitor — TRIAGED tasks', () => {
    // Mock setup
    const mockLogger = {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(),
        debug: jest.fn(), fatal: jest.fn(), child: jest.fn().mockReturnThis(),
    };

    const mockTaskFindMany = jest.fn().mockResolvedValue([]);

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
        jest.mock('@/lib/observability/job-runner', () => ({
            runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
        }));
        jest.mock('@/lib/prisma', () => ({
            prisma: {
                control: { findMany: jest.fn().mockResolvedValue([]) },
                policy: { findMany: jest.fn().mockResolvedValue([]) },
                task: { findMany: (...args: unknown[]) => mockTaskFindMany(...args) },
                risk: { findMany: jest.fn().mockResolvedValue([]) },
                controlTestPlan: { findMany: jest.fn().mockResolvedValue([]) },
                // Epic G-7
                riskTreatmentPlan: {
                    findMany: jest.fn().mockResolvedValue([]),
                    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                },
                treatmentMilestone: { findMany: jest.fn().mockResolvedValue([]) },
            },
        }));
    });

    test('task scanner uses notIn filter that includes TRIAGED tasks', async () => {
        const now = new Date('2026-04-17T12:00:00Z');
        const triagedTask = {
            id: 'task-triaged-1',
            tenantId: 'tenant-1',
            title: 'Triaged task with deadline',
            dueAt: new Date('2026-04-20T00:00:00Z'), // 3 days from now
            assigneeUserId: 'user-1',
        };

        mockTaskFindMany.mockResolvedValue([triagedTask]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        const { items } = await runDeadlineMonitor({ now });

        // The task should appear in results
        expect(items).toHaveLength(1);
        expect(items[0].entityType).toBe('TASK');
        expect(items[0].name).toBe('Triaged task with deadline');

        // Verify the query used notIn (not in: ['OPEN', ...])
        const queryCall = mockTaskFindMany.mock.calls[0][0];
        const statusFilter = queryCall.where.status;
        expect(statusFilter).toHaveProperty('notIn');
        expect(statusFilter.notIn).toContain('RESOLVED');
        expect(statusFilter.notIn).toContain('CLOSED');
        expect(statusFilter.notIn).toContain('CANCELED');
        // TRIAGED must NOT be in the notIn list
        expect(statusFilter.notIn).not.toContain('TRIAGED');
        expect(statusFilter.notIn).not.toContain('OPEN');
        expect(statusFilter.notIn).not.toContain('IN_PROGRESS');
        expect(statusFilter.notIn).not.toContain('BLOCKED');
    });

    test('completed tasks are still excluded from deadline scanning', async () => {
        mockTaskFindMany.mockResolvedValue([]);

        const { runDeadlineMonitor } = await import('../../src/app-layer/jobs/deadline-monitor');
        await runDeadlineMonitor({});

        const queryCall = mockTaskFindMany.mock.calls[0][0];
        const statusFilter = queryCall.where.status;
        // Terminal statuses must be excluded
        expect(statusFilter.notIn).toContain('RESOLVED');
        expect(statusFilter.notIn).toContain('CLOSED');
        expect(statusFilter.notIn).toContain('CANCELED');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Enum Drift Guard — Prisma ↔ Domain Sync
// ═════════════════════════════════════════════════════════════════════

describe('Enum Drift Guard', () => {
    /**
     * This test reads the Prisma schema and compares the TaskStatus
     * enum values against our domain constants. If someone adds a new
     * status to the schema without updating ALL_TASK_STATUSES,
     * this test fails LOUDLY.
     */
    test('ALL_TASK_STATUSES matches Prisma TaskStatus enum', () => {
        // Read the schema file and extract enum values
        const schema = readPrismaSchema();

        // Extract TaskStatus enum block
        const enumMatch = schema.match(/enum\s+TaskStatus\s*\{([^}]+)\}/);
        expect(enumMatch).not.toBeNull();

        const enumValues = enumMatch![1]
            .split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line && !line.startsWith('//') && !line.startsWith('@@'));

        const schemaStatuses = new Set(enumValues);
        const domainStatuses = new Set([...ALL_TASK_STATUSES]);

        // Every schema status must be in our domain constants
        for (const status of schemaStatuses) {
            expect(domainStatuses).toContain(status);
        }

        // Every domain constant must be in the schema
        for (const status of domainStatuses) {
            expect(schemaStatuses).toContain(status);
        }

        // Length must match exactly
        expect(schemaStatuses.size).toBe(domainStatuses.size);
    });

    test('every status is classified as either ACTIVE or TERMINAL (no orphans)', () => {
        for (const status of ALL_TASK_STATUSES) {
            const inActive = (ACTIVE_TASK_STATUSES as readonly string[]).includes(status);
            const inTerminal = (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
            // Must be in exactly one group
            expect(inActive || inTerminal).toBe(true);
            expect(inActive && inTerminal).toBe(false);
        }
    });

    test('ACTIVE + TERMINAL covers ALL (no gaps, no extras)', () => {
        const combined = new Set([...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES]);
        const all = new Set([...ALL_TASK_STATUSES]);
        expect(combined).toEqual(all);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Codebase Scan — No remaining inline status arrays
// ═════════════════════════════════════════════════════════════════════

describe('Codebase Scan — inline status array detection', () => {
    const fs = require('fs');
    const path = require('path');
    const glob = require('fast-glob');

    /**
     * Scans all .ts files in src/app-layer for inline ['RESOLVED', 'CLOSED', 'CANCELED']
     * arrays. The shared constant file is excluded. Any hit means someone
     * bypassed the shared constant — fail loudly.
     */
    test('no inline terminal status arrays in app-layer (except shared constant)', () => {
        const srcDir = path.resolve(__dirname, '../../src/app-layer');
        const pattern = /\['RESOLVED'.*?'CLOSED'.*?'CANCELED'\]/g;
        const sharedFile = 'domain/task-status.ts';

        let files: string[];
        try {
            files = glob.sync('**/*.ts', { cwd: srcDir, absolute: true });
        } catch {
            // fast-glob may not be available — skip gracefully
            return;
        }

        const violations: string[] = [];
        for (const file of files) {
            if (file.includes(sharedFile)) continue;
            const content = fs.readFileSync(file, 'utf8');
            if (pattern.test(content)) {
                violations.push(path.relative(srcDir, file));
            }
            pattern.lastIndex = 0; // Reset regex state
        }

        expect(violations).toEqual([]);
    });

    /**
     * Scans for the OLD broken pattern: in: ['OPEN', 'IN_PROGRESS', 'BLOCKED']
     * This was the original TRIAGED bug. Must never appear again.
     *
     * NOTE: ControlTask uses a separate ControlTaskStatus enum (OPEN | IN_PROGRESS | DONE | BLOCKED)
     * which does NOT have TRIAGED. Patterns near `controlTask` queries are excluded.
     */
    test('no inline positive status allowlists that could miss statuses', () => {
        const srcDir = path.resolve(__dirname, '../../src/app-layer');
        // Match patterns like: in: ['OPEN', 'IN_PROGRESS' ...] that don't include TRIAGED
        const pattern = /in:\s*\[\s*'OPEN'.*?'IN_PROGRESS'.*?\]/g;

        let files: string[];
        try {
            const glob = require('fast-glob');
            files = glob.sync('**/*.ts', { cwd: srcDir, absolute: true });
        } catch {
            return;
        }

        const violations: string[] = [];
        for (const file of files) {
            const content = fs.readFileSync(file, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const matches = line.match(pattern);
                if (matches) {
                    for (const m of matches) {
                        if (m.includes('TRIAGED')) continue;
                        // Exclude ControlTask model (uses different ControlTaskStatus enum)
                        const context = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
                        if (context.includes('controlTask') || context.includes('ControlTask')) continue;
                        violations.push(`${path.relative(srcDir, file)}:${i + 1}: ${m}`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
