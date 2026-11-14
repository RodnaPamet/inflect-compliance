/** @jest-environment jsdom */

/**
 * The rule builder in edit mode (#5309).
 *
 *   - Until THIS rule's detail has loaded, Next and Save wait. Opening Edit on
 *     rule A, cancelling, then opening Edit on rule B used to leave A's name,
 *     trigger and config in the form while B's detail was in flight — or for
 *     good, if that GET failed — and Save PUT them over B.
 *   - Changing the trigger event drops a preserved nested filter, as it drops
 *     the flat conditions: the old event's fields can never match the new one.
 *
 * The modal and the comboboxes are stubbed as plain elements — what is under
 * test is what the builder does with the choice, not how a dropdown is drawn.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const en = require('../../messages/en.json');
const rb = en.automation.ruleBuilder;

jest.mock('@/components/ui/modal', () => {
    const Modal = ({ showModal, children }: { showModal: boolean; children: React.ReactNode }) =>
        showModal ? <div>{children}</div> : null;
    function Header() {
        return null;
    }
    function Section({ children }: { children: React.ReactNode }) {
        return <div>{children}</div>;
    }
    Modal.Header = Header;
    Modal.Body = Section;
    Modal.Actions = Section;
    Modal.Footer = Section;
    return { Modal };
});
jest.mock('@/components/ui/combobox', () => ({
    Combobox: ({
        options,
        selected,
        setSelected,
        placeholder,
    }: {
        options: Array<{ value: string; label: string }>;
        selected: { value: string } | null;
        setSelected: (o: { value: string; label: string } | null) => void;
        placeholder?: string;
    }) => (
        <select
            aria-label={placeholder}
            value={selected?.value ?? ''}
            onChange={(e) => setSelected(options.find((o) => o.value === e.target.value) ?? null)}
        >
            <option value="">none</option>
            {options.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    ),
}));
jest.mock('@/components/ui/user-combobox', () => ({ UserCombobox: () => null }));
jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    return { useTenantApiUrl: () => apiUrl };
});

// `key → { data, error }`; a key absent from the map is still loading.
const mockSwr = new Map<string, { data?: unknown; error?: unknown }>();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => (key && mockSwr.get(key)) || { data: undefined, error: undefined },
}));

import { RuleBuilderModal, type RuleDetail } from '@/components/processes/RuleBuilderModal';

const row = (id: string, name: string) => ({
    id,
    name,
    triggerEvent: 'RISK_CREATED',
    actionType: 'NOTIFY_USER' as const,
    status: 'ENABLED' as const,
    priority: 0,
    executionCount: 0,
    lastTriggeredAt: null,
});

function detail(name: string, over: Partial<RuleDetail> = {}): RuleDetail {
    return {
        name,
        description: null,
        triggerEvent: 'RISK_CREATED',
        actionType: 'NOTIFY_USER',
        triggerFilterJson: null,
        actionConfigJson: { userIds: ['u1'], message: 'hello' },
        slaWindowMinutes: null,
        slaBreachActionType: null,
        slaBreachConfigJson: null,
        scheduleConfigJson: null,
        nextRuleId: null,
        nextRuleDelay: null,
        elseRuleId: null,
        ...over,
    };
}

const nextButton = () => screen.getByRole('button', { name: rb.next }) as HTMLButtonElement;

beforeEach(() => {
    mockSwr.clear();
});

describe('rule builder — edit waits for this rule', () => {
    it('does not offer Next with the previous rule still in the form', () => {
        mockSwr.set('/automation/rules/rule-a', { data: detail('Rule A') });
        const setOpen = jest.fn();
        const { rerender } = render(
            <RuleBuilderModal tenantSlug="acme" open setOpen={setOpen} editRule={row('rule-a', 'Rule A')} />,
        );
        expect(nextButton().disabled).toBe(false);

        // Cancel, then Edit on rule B, whose detail has not arrived.
        rerender(<RuleBuilderModal tenantSlug="acme" open={false} setOpen={setOpen} editRule={null} />);
        rerender(<RuleBuilderModal tenantSlug="acme" open setOpen={setOpen} editRule={row('rule-b', 'Rule B')} />);

        expect(nextButton().disabled).toBe(true);
        expect(screen.getByTestId('rule-builder-detail-state')).toHaveTextContent(rb.detailLoading);
        expect(screen.queryByDisplayValue('Rule A')).toBeNull();

        // B's detail lands: the form is B's, and Next is offered.
        mockSwr.set('/automation/rules/rule-b', { data: detail('Rule B') });
        rerender(<RuleBuilderModal tenantSlug="acme" open setOpen={setOpen} editRule={row('rule-b', 'Rule B')} />);
        expect(screen.getByDisplayValue('Rule B')).toBeTruthy();
        expect(nextButton().disabled).toBe(false);
        expect(screen.queryByTestId('rule-builder-detail-state')).toBeNull();
    });

    it('says the rule could not be loaded, and still offers no Next', () => {
        mockSwr.set('/automation/rules/rule-b', { error: new Error('500') });
        render(<RuleBuilderModal tenantSlug="acme" open setOpen={jest.fn()} editRule={row('rule-b', 'Rule B')} />);
        expect(screen.getByTestId('rule-builder-detail-state')).toHaveTextContent(rb.detailLoadFailed);
        expect(nextButton().disabled).toBe(true);
    });
});

describe('rule builder — a new trigger event drops the old nested filter', () => {
    const nested = {
        logic: 'AND',
        conditions: [
            {
                logic: 'OR',
                conditions: [
                    { field: 'score', operator: 'gt', value: 10 },
                    { field: 'category', operator: 'eq', value: 'CYBER' },
                ],
            },
        ],
    } as unknown as RuleDetail['triggerFilterJson'];

    function openOnStepTwo(changeEventTo?: string) {
        mockSwr.set('/automation/rules/rule-a', { data: detail('Rule A', { triggerFilterJson: nested }) });
        render(<RuleBuilderModal tenantSlug="acme" open setOpen={jest.fn()} editRule={row('rule-a', 'Rule A')} />);
        if (changeEventTo) {
            const event = screen.getByLabelText(rb.selectEvent) as HTMLSelectElement;
            fireEvent.change(event, { target: { value: changeEventTo } });
            expect(event.value).toBe(changeEventTo);
        }
        fireEvent.click(nextButton());
    }

    it('keeps the preserved filter while the event is unchanged', () => {
        openOnStepTwo();
        expect(screen.getByText(rb.advancedFilterTitle)).toBeTruthy();
    });

    it('drops it when the event changes', () => {
        openOnStepTwo('CONTROL_STATUS_CHANGED');
        expect(screen.queryByText(rb.advancedFilterTitle)).toBeNull();
    });
});
