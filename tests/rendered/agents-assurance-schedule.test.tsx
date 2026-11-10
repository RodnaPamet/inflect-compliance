/**
 * SCHEDULING THE ASSURANCE CHECKS FROM THE REGISTER (#5014).
 *
 * Every check read "never run" because nothing in the product could schedule
 * one. The panel now tells "not scheduled" from "scheduled, not yet run", and
 * offers the setup — a dry run that names each plan's control, then the write
 * on confirmation — only to a reader the server says may make it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params) {
            for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

import { AssurancePanel } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

const assurance = (scheduled: boolean) => ({
    riskCoverage: { scored: 2, total: 3 },
    sampleAudit: { answered: 0, dissented: 0, disagreementRate: null },
    controlTests: [
        { checkId: 'AGENTIC_REVIEW_QUALITY', title: 'Review quality', result: null, lastRunAt: null, scheduled },
        { checkId: 'AGENTIC_KILL_SWITCH_DRILL', title: 'Kill switch drill', result: null, lastRunAt: null, scheduled },
    ],
});

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    refresh.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
});

const answer = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

describe('an unscheduled check says so', () => {
    it('reads "not scheduled", not "never run", when no plan runs it', () => {
        render(<AssurancePanel assurance={assurance(false)} />);
        expect(screen.getByTestId('agents-assurance-never-AGENTIC_KILL_SWITCH_DRILL').textContent).toBe('not scheduled');
    });

    it('reads "never run" when a plan runs it and has not yet', () => {
        render(<AssurancePanel assurance={assurance(true)} />);
        expect(screen.getByTestId('agents-assurance-never-AGENTIC_KILL_SWITCH_DRILL').textContent).toBe('never run');
    });
});

describe('the setup is offered only where the server takes it', () => {
    it('is not offered to a reader who may not schedule', () => {
        render(<AssurancePanel assurance={assurance(false)} tenantSlug="acme" />);
        expect(screen.queryByTestId('agents-assurance-schedule')).toBeNull();
    });

    it('is not offered when every check is already scheduled', () => {
        render(<AssurancePanel assurance={assurance(true)} tenantSlug="acme" canSchedule />);
        expect(screen.queryByTestId('agents-assurance-schedule')).toBeNull();
    });
});

describe('a dry run first, then the write', () => {
    it('previews each plan\'s control, writes on confirmation, and re-reads the register', async () => {
        fetchMock
            .mockReturnValueOnce(
                answer({
                    ok: true,
                    applied: false,
                    steps: [
                        { check: 'AGENTIC_KILL_SWITCH_DRILL', title: 'Kill switch drill', outcome: 'WOULD_CHANGE', control: { id: 'c1', code: 'AG-8', name: 'Stop control' } },
                        { check: 'AGENTIC_REVIEW_QUALITY', title: 'Review quality', outcome: 'UNCHANGED', control: null },
                    ],
                }),
            )
            .mockReturnValueOnce(answer({ ok: true, applied: true, steps: [] }));

        render(<AssurancePanel assurance={assurance(false)} tenantSlug="acme" canSchedule />);
        fireEvent.click(screen.getByText('Schedule these checks'));

        const list = await screen.findByTestId('agents-assurance-schedule-preview-list');
        // Only what would change is previewed, with the control it lands on.
        expect(list.textContent).toBe('Kill switch drill on AG-8 Stop control');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ apply: false });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/t/acme/admin/agents/assurance-checks');

        fireEvent.click(screen.getByText('Schedule checks'));
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ apply: true });
    });

    it('shows a named refusal and writes nothing', async () => {
        fetchMock.mockReturnValueOnce(
            answer({ ok: false, refusal: 'CONTROL_MISSING', detail: 'Kill switch drill: no live control is linked to ASI08 or ASI10.' }),
        );
        render(<AssurancePanel assurance={assurance(false)} tenantSlug="acme" canSchedule />);
        fireEvent.click(screen.getByText('Schedule these checks'));

        expect((await screen.findByTestId('agents-assurance-schedule-error')).textContent).toMatch(/no live control is linked to ASI08/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();
    });
});
