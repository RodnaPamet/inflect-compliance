/**
 * Epic 63 — list/table rollout coverage.
 *
 * Pins the call shapes used by every page that adopted
 * `<TimestampTooltip>` in this rollout pass. The primitive itself
 * is covered exhaustively by `tests/rendered/timestamp-tooltip.test.tsx`
 * — this file proves each page's *adoption shape* renders correctly.
 *
 * Strategy: don't mount the heavy client modules (each pulls
 * React Query + filter context + Next router). Instead, mirror the
 * exact JSX shape each page wraps the primitive in, and assert the
 * deterministic visible text + tooltip content + null fallback.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { render } from '@testing-library/react';

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({
        children,
        content,
    }: {
        children: React.ReactNode;
        content: React.ReactNode;
    }) => (
        <span data-testid="tooltip-mock">
            {children}
            <span data-testid="tooltip-content">{content}</span>
        </span>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
    InfoTooltip: () => null,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';

const NOW = new Date('2026-05-03T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── Evidence cell shape ────────────────────────────────────────────

function EvidenceRetentionCell({
    retentionUntil,
    isArchived,
    id,
}: {
    retentionUntil: string | null;
    isArchived?: boolean;
    id: string;
}) {
    return (
        <div className="text-xs">
            <span className="badge badge-success">Active</span>
            {retentionUntil && !isArchived && (
                <TimestampTooltip
                    date={retentionUntil}
                    className="text-content-subtle mt-0.5 block"
                    data-testid={`evidence-row-retention-date-${id}`}
                    now={NOW}
                />
            )}
        </div>
    );
}

describe('Evidence — retention cell mounts TimestampTooltip', () => {
    it('renders relative time + tooltip when retentionUntil is set', () => {
        const future = new Date(NOW.getTime() + 10 * DAY).toISOString();
        const { getByTestId } = render(
            <EvidenceRetentionCell
                retentionUntil={future}
                id="ev_1"
            />,
        );
        const visible = getByTestId('evidence-row-retention-date-ev_1');
        expect(visible.textContent).toMatch(/in 10 days/);
    });

    it('omits the timestamp entirely when retentionUntil is null', () => {
        const { container, queryByTestId } = render(
            <EvidenceRetentionCell retentionUntil={null} id="ev_2" />,
        );
        expect(
            queryByTestId('evidence-row-retention-date-ev_2'),
        ).toBeNull();
        // The badge stays.
        expect(container.textContent).toContain('Active');
    });

    it('omits the timestamp when archived', () => {
        const future = new Date(NOW.getTime() + 10 * DAY).toISOString();
        const { queryByTestId } = render(
            <EvidenceRetentionCell
                retentionUntil={future}
                isArchived
                id="ev_3"
            />,
        );
        expect(
            queryByTestId('evidence-row-retention-date-ev_3'),
        ).toBeNull();
    });
});

// ─── Policies cell shape ───────────────────────────────────────────

function PolicyNextReviewCell({
    nextReviewAt,
    isOverdue,
    id,
}: {
    nextReviewAt: string | null;
    isOverdue: boolean;
    id: string;
}) {
    if (!nextReviewAt) {
        return <span className="text-xs text-content-muted">—</span>;
    }
    return (
        <span className="inline-flex items-center gap-1 text-xs text-content-muted">
            <TimestampTooltip date={nextReviewAt} now={NOW} />
            {isOverdue && (
                <span
                    className="badge badge-danger text-xs"
                    data-testid={`policy-overdue-${id}`}
                >
                    Overdue
                </span>
            )}
        </span>
    );
}

function PolicyUpdatedCell({ updatedAt }: { updatedAt: string | null }) {
    return (
        <TimestampTooltip
            date={updatedAt}
            className="text-xs text-content-subtle"
            now={NOW}
        />
    );
}

describe('Policies — nextReviewAt + updatedAt cells', () => {
    it('renders the next review timestamp + overdue badge together', () => {
        const past = new Date(NOW.getTime() - 5 * DAY).toISOString();
        const { container, getByTestId } = render(
            <PolicyNextReviewCell
                nextReviewAt={past}
                isOverdue
                id="pol_1"
            />,
        );
        // Both the relative phrase and the overdue badge sit in the row.
        expect(container.textContent).toMatch(/5 days ago/);
        expect(getByTestId('policy-overdue-pol_1').textContent).toBe(
            'Overdue',
        );
    });

    it('renders "—" when next review date is null', () => {
        const { container, queryByTestId } = render(
            <PolicyNextReviewCell
                nextReviewAt={null}
                isOverdue={false}
                id="pol_2"
            />,
        );
        expect(container.textContent).toBe('—');
        expect(queryByTestId('tooltip-mock')).toBeNull();
    });

    it('renders the updated cell with relative phrasing + tooltip', () => {
        const updated = new Date(NOW.getTime() - 2 * HOUR).toISOString();
        const { container, getByTestId } = render(
            <PolicyUpdatedCell updatedAt={updated} />,
        );
        const visible = container.querySelector('[data-timestamp-tooltip]');
        expect(visible?.textContent).toMatch(/2 hours ago/);
        // Tooltip carries the long-form exact timestamp.
        expect(getByTestId('tooltip-content').textContent).toMatch(
            /May 2026/,
        );
    });
});

// ─── Tasks cell shape ──────────────────────────────────────────────

function TaskDueCell({ dueAt }: { dueAt: string | null }) {
    return (
        <TimestampTooltip
            date={dueAt}
            className="text-xs text-content-muted"
            now={NOW}
        />
    );
}

function TaskUpdatedCell({ updatedAt }: { updatedAt: string }) {
    return (
        <TimestampTooltip
            date={updatedAt}
            className="text-xs text-content-muted"
            now={NOW}
        />
    );
}

describe('Tasks — dueAt + updatedAt cells', () => {
    it('renders future dueAt as "in N days" with tooltip', () => {
        const due = new Date(NOW.getTime() + 5 * DAY).toISOString();
        const { container, getByTestId } = render(
            <TaskDueCell dueAt={due} />,
        );
        expect(container.textContent).toMatch(/in 5 days/);
        expect(getByTestId('tooltip-content').textContent).toMatch(
            /May 2026/,
        );
    });

    it('renders "—" when dueAt is null', () => {
        const { container, queryByTestId } = render(
            <TaskDueCell dueAt={null} />,
        );
        expect(container.textContent).toBe('—');
        expect(queryByTestId('tooltip-mock')).toBeNull();
    });

    it('renders past updatedAt with "ago" phrasing', () => {
        const updated = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
        const { container } = render(
            <TaskUpdatedCell updatedAt={updated} />,
        );
        expect(container.textContent).toMatch(/30 minutes ago/);
    });
});

// ─── Vendors cell shape ────────────────────────────────────────────

function VendorDateCell({
    date,
    isOverdue,
    label,
    tone,
}: {
    date: string | null;
    isOverdue: boolean;
    label: 'Overdue' | 'Due';
    tone: 'error' | 'warning';
}) {
    return (
        <span>
            <TimestampTooltip date={date} now={NOW} />
            {isOverdue && (
                <span className={`ml-1 text-xs text-content-${tone} font-semibold`}>
                    {label}
                </span>
            )}
        </span>
    );
}

describe('Vendors — Next Review + Contract Renewal cells', () => {
    it('renders Next Review with overdue badge when in the past', () => {
        const past = new Date(NOW.getTime() - 14 * DAY).toISOString();
        const { container } = render(
            <VendorDateCell
                date={past}
                isOverdue
                label="Overdue"
                tone="error"
            />,
        );
        expect(container.textContent).toMatch(/14 days ago/);
        expect(container.textContent).toContain('Overdue');
    });

    it('renders Contract Renewal with Due badge when in the past', () => {
        const past = new Date(NOW.getTime() - 2 * DAY).toISOString();
        const { container } = render(
            <VendorDateCell
                date={past}
                isOverdue
                label="Due"
                tone="warning"
            />,
        );
        expect(container.textContent).toMatch(/2 days ago/);
        expect(container.textContent).toContain('Due');
    });

    it('renders "—" with no badge when the date is missing', () => {
        const { container, queryByTestId } = render(
            <VendorDateCell
                date={null}
                isOverdue={false}
                label="Overdue"
                tone="error"
            />,
        );
        // TimestampTooltip's empty state — and no badge.
        expect(container.textContent).toBe('—');
        expect(queryByTestId('tooltip-mock')).toBeNull();
    });
});

// ─── Cross-page consistency ────────────────────────────────────────

describe('Rollout consistency — null/empty handling matches across pages', () => {
    // Pages that pass `null` straight to TimestampTooltip share the
    // primitive's `—` fallback. Evidence is excluded — its cell hides
    // the date row entirely when `retentionUntil` is null (the
    // retention-status badge is the cell's only content), so the
    // primitive's empty path never runs.
    it('Policies / Tasks / Vendors all emit "—" with no Tooltip wrapper for null', () => {
        const variants = [
            <PolicyNextReviewCell
                key="pn"
                nextReviewAt={null}
                isOverdue={false}
                id="x"
            />,
            <PolicyUpdatedCell key="pu" updatedAt={null} />,
            <TaskDueCell key="td" dueAt={null} />,
            <VendorDateCell
                key="vd"
                date={null}
                isOverdue={false}
                label="Overdue"
                tone="error"
            />,
        ];
        for (const variant of variants) {
            const { container, queryByTestId, unmount } = render(variant);
            expect(container.textContent).toContain('—');
            expect(queryByTestId('tooltip-mock')).toBeNull();
            unmount();
        }
    });

    it('Evidence cell omits the date entirely (no "—") when null', () => {
        const { container, queryByTestId } = render(
            <EvidenceRetentionCell retentionUntil={null} id="x" />,
        );
        // No "—" — the badge alone fills the cell.
        expect(container.textContent).not.toContain('—');
        expect(queryByTestId('tooltip-mock')).toBeNull();
        // The status badge stays so the cell isn't blank.
        expect(container.textContent).toContain('Active');
    });
});
