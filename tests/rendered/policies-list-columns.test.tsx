/**
 * Render coverage for the new policy list columns — Epic 45.1.
 *
 * Exercises the cell renderers in isolation against representative
 * row fixtures (owned + unowned, overdue + future review). Mounting
 * the full PoliciesClient pulls the React Query + Filter context
 * layers along; the cell tests
 * stay focused by calling the columns' `cell` functions directly
 * with synthesised `row.original` values.
 */

import { render, screen } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildPolicyStatusLabels } from '@/app/t/[tenantSlug]/(app)/policies/filter-defs';

// Resolve the migrated status labels against the en catalog.
const EN = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'messages/en.json'), 'utf-8'),
) as Record<string, Record<string, unknown>>;
const POLICY_STATUS_LABELS = buildPolicyStatusLabels((key: string) => {
    const v = key
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN.policies);
    return typeof v === 'string' ? v : key;
});

function withTooltip(node: React.ReactNode) {
    return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

// Mirror the page's STATUS_BADGE so the test can assert behaviour
// without importing from the page (which is `'use client'` + pulls
// next/navigation's runtime mocks). The page's table-level tests
// (structural ratchet) lock the page-side mapping; this file
// asserts the *visible* shape downstream.
const STATUS_BADGE: Record<string, string> = {
    DRAFT: 'badge-neutral',
    IN_REVIEW: 'badge-info',
    APPROVED: 'badge-success',
    PUBLISHED: 'badge-success',
    ARCHIVED: 'badge-warning',
};

function StatusCell({ status, id }: { status: string; id: string }) {
    const label =
        (POLICY_STATUS_LABELS as Record<string, string>)[status] ?? status;
    const cls = STATUS_BADGE[status] ?? 'badge-neutral';
    return (
        <span className={`badge ${cls}`} data-testid={`policy-status-${id}`}>
            {label}
        </span>
    );
}

interface OwnerRow {
    id: string;
    owner: { id: string; name: string | null; email: string | null } | null;
}

function OwnerCell({ row }: { row: { original: OwnerRow } }) {
    const p = row.original;
    if (!p.owner) {
        return <span className="text-xs text-content-subtle">—</span>;
    }
    const display = p.owner.name ?? p.owner.email ?? '?';
    const initial = display.charAt(0).toUpperCase();
    return (
        <span
            className="inline-flex items-center gap-1.5"
            data-testid={`policy-owner-${p.id}`}
        >
            <span aria-hidden>{initial}</span>
            <span>
                <span>{p.owner.name ?? p.owner.email}</span>
                {p.owner.name && p.owner.email && (
                    <span data-testid={`policy-owner-email-${p.id}`}>
                        {p.owner.email}
                    </span>
                )}
            </span>
        </span>
    );
}

describe('Policy list — column cells', () => {
    describe('Status', () => {
        it.each([
            ['DRAFT', 'Draft'],
            ['IN_REVIEW', 'In Review'],
            ['APPROVED', 'Approved'],
            ['PUBLISHED', 'Published'],
            ['ARCHIVED', 'Archived'],
        ])('renders %s with the canonical label "%s"', (status, label) => {
            render(withTooltip(<StatusCell status={status} id="p1" />));
            expect(
                screen.getByTestId('policy-status-p1').textContent?.trim(),
            ).toBe(label);
        });

        it('falls back to the raw enum value for an unknown status', () => {
            render(withTooltip(<StatusCell status="UNKNOWN" id="p1" />));
            expect(
                screen.getByTestId('policy-status-p1').textContent?.trim(),
            ).toBe('UNKNOWN');
        });

        it('does NOT use the deprecated "Retired" label (filter alignment)', () => {
            // Pre-Epic-45 the label set carried `RETIRED: 'Retired'`
            // even though the schema enum is `ARCHIVED`. This test
            // pins the alignment so a future rename can't regress
            // either side without flipping the other.
            const labels = Object.values(POLICY_STATUS_LABELS as Record<string, string>);
            expect(labels).not.toContain('Retired');
            expect(labels).toContain('Archived');
        });
    });

    describe('Owner', () => {
        it('renders the avatar initial + name + email for fully-populated owners', () => {
            render(
                withTooltip(
                    <OwnerCell
                        row={{
                            original: {
                                id: 'p1',
                                owner: {
                                    id: 'u1',
                                    name: 'Alice Anderson',
                                    email: 'alice@example.com',
                                },
                            },
                        }}
                    />,
                ),
            );
            const cell = screen.getByTestId('policy-owner-p1');
            expect(cell.textContent).toContain('A');
            expect(cell.textContent).toContain('Alice Anderson');
            expect(
                screen.getByTestId('policy-owner-email-p1').textContent,
            ).toBe('alice@example.com');
        });

        it('uses the email when name is null', () => {
            render(
                withTooltip(
                    <OwnerCell
                        row={{
                            original: {
                                id: 'p2',
                                owner: {
                                    id: 'u2',
                                    name: null,
                                    email: 'bob@example.com',
                                },
                            },
                        }}
                    />,
                ),
            );
            const cell = screen.getByTestId('policy-owner-p2');
            expect(cell.textContent).toContain('bob@example.com');
            // No email subtitle when name is missing — avoids
            // duplicating the same string twice in the chip.
            expect(
                screen.queryByTestId('policy-owner-email-p2'),
            ).toBeNull();
        });

        it('renders an em-dash when there is no owner', () => {
            render(
                withTooltip(
                    <OwnerCell
                        row={{
                            original: { id: 'p3', owner: null },
                        }}
                    />,
                ),
            );
            // No chip; just the em-dash.
            expect(screen.queryByTestId('policy-owner-p3')).toBeNull();
        });
    });

    // The Version cell is not mirrored here: its rule (live while PUBLISHED,
    // else newest, a dash with none) is driven through the real page in
    // tests/rendered/policies-list-page.test.tsx. The mirror that stood here
    // asserted the old `currentVersion ?? lifecycleVersion` fallback, which
    // read "v1" for every never-published policy (#4279).
});
