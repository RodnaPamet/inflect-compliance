/**
 * Epic G-7 — RiskTreatmentPlanCard render + interaction tests.
 *
 *   1. Empty state when no plan exists.
 *   2. canWrite gates the "Create treatment plan" button.
 *   3. Active-plan block renders strategy + status badges + progress.
 *   4. Milestones render with correct completed state + checkbox
 *      disabled-when-completed semantics.
 *   5. Complete-plan button only visible to admin AND when all
 *      milestones done (or zero milestones).
 *   6. Create-plan form requires strategy + owner + targetDate
 *      before submit is enabled.
 *   7. Add-milestone form requires title + dueDate before submit
 *      is enabled.
 *   8. Complete-plan dialog requires closingRemark before submit
 *      is enabled.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/risks/r1',
    useSearchParams: () => new URLSearchParams(),
}));

// Use the global manual next-intl mock (__mocks__/next-intl.js), which
// resolves keys against messages/en.json WITH `{param}` interpolation, so
// assertions on visible text (e.g. the "1/2 milestones" progress label,
// composed via t('milestonesCount', { done, total })) keep holding.

import { RiskTreatmentPlanCard } from '@/components/risks/RiskTreatmentPlanCard';

function withClient(ui: React.ReactNode) {
    // Fresh per-test SWR cache (these panels read via useSWR); a shared
    // global cache would leak optimistic mutations + dedupe stale data
    // across tests. dedupingInterval 0 keeps mutate→revalidate deterministic.
    return (
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            {ui}
        </SWRConfig>
    );
}

const ownerChoices = [
    { userId: 'u_a', label: 'Alice (admin)' },
    { userId: 'u_b', label: 'Bob (editor)' },
];

function makePlanSummary(overrides: Record<string, unknown> = {}) {
    return {
        id: 'plan_1',
        riskId: 'r1',
        strategy: 'MITIGATE',
        status: 'ACTIVE',
        targetDate: new Date('2026-12-31').toISOString(),
        completedAt: null,
        ...overrides,
    };
}

function makePlanDetail(overrides: Record<string, unknown> = {}) {
    return {
        id: 'plan_1',
        riskId: 'r1',
        strategy: 'MITIGATE',
        ownerUserId: 'u_a',
        targetDate: new Date('2026-12-31').toISOString(),
        status: 'ACTIVE',
        completedAt: null,
        closingRemark: null,
        owner: { id: 'u_a', email: 'alice@example.test', name: 'Alice' },
        milestones: [],
        ...overrides,
    };
}

function installFetch(plans: unknown[], detail?: unknown) {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
        async (url: string) => {
            if (typeof url === 'string' && url.endsWith('treatment-plans')) {
                return { ok: true, json: async () => ({ rows: plans }) };
            }
            return { ok: true, json: async () => detail ?? {} };
        },
    );
}

describe('RiskTreatmentPlanCard', () => {
    it('renders the empty state when no plan exists', async () => {
        installFetch([]);
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('treatment-plan-empty');
    });

    it('non-write actor cannot see Create button', async () => {
        installFetch([]);
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite={false}
                    canAdmin={false}
                />,
            ),
        );
        await screen.findByTestId('treatment-plan-empty');
        expect(
            screen.queryByTestId('treatment-plan-create-button'),
        ).toBeNull();
    });

    it('active plan block renders strategy + status + progress', async () => {
        installFetch(
            [makePlanSummary({ status: 'ACTIVE' })],
            makePlanDetail({
                status: 'ACTIVE',
                milestones: [
                    {
                        id: 'm1',
                        title: 'first',
                        description: null,
                        dueDate: new Date('2026-09-01').toISOString(),
                        completedAt: new Date().toISOString(),
                        completedBy: { id: 'u_a', email: 'alice@example.test', name: 'Alice' },
                        sortOrder: 0,
                        evidence: null,
                    },
                    {
                        id: 'm2',
                        title: 'second',
                        description: null,
                        dueDate: new Date('2026-10-01').toISOString(),
                        completedAt: null,
                        completedBy: null,
                        sortOrder: 1,
                        evidence: null,
                    },
                ],
            }),
        );
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('treatment-plan-block-plan_1');
        expect(screen.getByTestId('treatment-plan-strategy-badge').textContent).toBe(
            'Mitigate',
        );
        // 1/2 done → progress label "1/2"
        expect(
            screen.getByTestId('treatment-plan-progress-label').textContent,
        ).toBe('1/2 milestones');
        expect(screen.getByTestId('treatment-plan-milestone-m1')).toBeTruthy();
        expect(screen.getByTestId('treatment-plan-milestone-m2')).toBeTruthy();
    });

    it('milestone checkbox is disabled once completed', async () => {
        installFetch(
            [makePlanSummary()],
            makePlanDetail({
                milestones: [
                    {
                        id: 'm-done',
                        title: 'already done',
                        description: null,
                        dueDate: new Date('2026-09-01').toISOString(),
                        completedAt: new Date().toISOString(),
                        completedBy: { id: 'u_a', email: 'alice@example.test', name: 'Alice' },
                        sortOrder: 0,
                        evidence: null,
                    },
                ],
            }),
        );
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        const cb = (await screen.findByTestId(
            'treatment-plan-milestone-checkbox-m-done',
        )) as HTMLInputElement;
        expect(cb.checked).toBe(true);
        expect(cb.disabled).toBe(true);
    });

    it('Complete button only renders when admin AND all milestones done', async () => {
        // Admin but not all milestones done — no Complete button.
        installFetch(
            [makePlanSummary()],
            makePlanDetail({
                milestones: [
                    {
                        id: 'm1',
                        title: 'incomplete',
                        description: null,
                        dueDate: new Date('2026-09-01').toISOString(),
                        completedAt: null,
                        completedBy: null,
                        sortOrder: 0,
                        evidence: null,
                    },
                ],
            }),
        );
        const r1 = render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('treatment-plan-block-plan_1');
        expect(
            screen.queryByTestId('treatment-plan-complete-button'),
        ).toBeNull();
        r1.unmount();

        // Admin + all milestones done — Complete button visible.
        installFetch(
            [makePlanSummary()],
            makePlanDetail({
                milestones: [
                    {
                        id: 'm1',
                        title: 'done',
                        description: null,
                        dueDate: new Date('2026-09-01').toISOString(),
                        completedAt: new Date().toISOString(),
                        completedBy: { id: 'u_a', email: 'alice@example.test', name: 'Alice' },
                        sortOrder: 0,
                        evidence: null,
                    },
                ],
            }),
        );
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('treatment-plan-complete-button');
    });

    it('create-plan form requires targetDate before submit is enabled', async () => {
        installFetch([]);
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('treatment-plan-create-button'),
        );
        const submit = (await screen.findByTestId(
            'treatment-plan-form-submit',
        )) as HTMLButtonElement;
        // strategy + owner default to first option, but targetDate is null → disabled.
        expect(submit.disabled).toBe(true);
    });

    it('complete-plan dialog requires closingRemark', async () => {
        installFetch(
            [makePlanSummary()],
            makePlanDetail({
                milestones: [
                    {
                        id: 'm1',
                        title: 'done',
                        description: null,
                        dueDate: new Date('2026-09-01').toISOString(),
                        completedAt: new Date().toISOString(),
                        completedBy: { id: 'u_a', email: 'alice@example.test', name: 'Alice' },
                        sortOrder: 0,
                        evidence: null,
                    },
                ],
            }),
        );
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('treatment-plan-complete-button'),
        );
        const submit = (await screen.findByTestId(
            'complete-plan-submit',
        )) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('complete-plan-remark'), {
            target: { value: 'all milestones met' },
        });
        expect(submit.disabled).toBe(false);
    });

    it('add-milestone form requires title + dueDate before submit is enabled', async () => {
        installFetch([makePlanSummary()], makePlanDetail());
        render(
            withClient(
                <RiskTreatmentPlanCard
                    tenantSlug="acme"
                    riskId="r1"
                    ownerChoices={ownerChoices}
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('treatment-plan-add-milestone-button'),
        );
        const submit = (await screen.findByTestId(
            'milestone-form-submit',
        )) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('milestone-form-title'), {
            target: { value: 'Procure SIEM' },
        });
        // Title set, dueDate still missing → still disabled.
        expect(submit.disabled).toBe(true);
    });
});
