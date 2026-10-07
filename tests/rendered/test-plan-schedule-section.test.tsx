/**
 * Epic G-2 prompt 5 — TestPlanScheduleSection render tests.
 *
 * The component is the schedule picker + next-run indicator that
 * mounts on the test-plan detail page. These tests pin the four
 * load-bearing UX contracts:
 *
 *   1. Cadence catalog renders (Off / Daily / Weekly / Monthly /
 *      Quarterly) — no raw cron exposed.
 *   2. Next-run indicator color-codes correctly (overdue / today /
 *      normal / no-schedule).
 *   3. Changing cadence triggers a PUT to the new G-2 schedule
 *      endpoint with the right shape (cron + automationType).
 *   4. Permission gating disables the picker and hides the save
 *      button when canEdit=false.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

// Stable formatDate output so the tests don't depend on the
// machine's locale.
jest.mock('@inflect/ui/lib/format-date', () => ({
    formatDate: (iso: string) => `formatted(${iso})`,
}));

import { TestPlanScheduleSection } from '@/components/TestPlanScheduleSection';

const BASE_PROPS = {
    planId: 'plan-1',
    initialAutomationType: 'MANUAL' as const,
    initialSchedule: null,
    initialScheduleTimezone: null,
    initialNextRunAt: null,
    canEdit: true,
};

const ORIGINAL_FETCH = global.fetch;

// Plain-object fetch response — jsdom doesn't define `Response`, and
// the component only reaches for `.ok`, `.status`, and `.text()`.
function fakeOk(body: unknown = { id: 'plan-1' }) {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
    } as unknown as Response;
}

function fakeError(status: number, body: unknown) {
    return {
        ok: false,
        status,
        text: async () => JSON.stringify(body),
        json: async () => body,
    } as unknown as Response;
}

beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue(fakeOk());
});

afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
});

// ─── 1. Initial render ─────────────────────────────────────────────

describe('TestPlanScheduleSection — initial render', () => {
    test('shows the section + tz line + "no automated runs scheduled"', () => {
        render(<TestPlanScheduleSection {...BASE_PROPS} />);

        expect(
            screen.getByTestId('test-plan-schedule-section'),
        ).toBeInTheDocument();
        // The tz indicator is auto-derived from Intl. We don't assert
        // a specific tz (depends on the test environment) but we do
        // assert the prefix is correct.
        expect(screen.getByText(/All times in /)).toBeInTheDocument();

        // No-schedule indicator copy.
        const indicator = screen.getByTestId('test-plan-next-run-indicator');
        expect(indicator).toHaveTextContent(
            /No automated runs scheduled/i,
        );
    });

    test('does NOT expose raw cron strings in the visible UI', () => {
        // Render with a saved schedule so the picker has a non-OFF
        // value selected.
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                initialSchedule="0 9 * * MON"
                initialScheduleTimezone="UTC"
            />,
        );

        // The cron string MUST NOT appear anywhere in the rendered
        // tree. Querying by text is the user-facing surface — this
        // is the prompt-5 invariant ("don't expose raw cron").
        expect(screen.queryByText('0 9 * * MON')).not.toBeInTheDocument();
        expect(screen.queryByText(/\* \* \* MON/)).not.toBeInTheDocument();

        // The friendly label IS visible.
        expect(
            screen.getAllByText(/Weekly \(Mondays at 09:00\)/).length,
        ).toBeGreaterThan(0);
    });
});

// ─── 2. Next-run indicator color coding ────────────────────────────

describe('TestPlanScheduleSection — next-run indicator', () => {
    test('overdue tone when nextRunAt is in the past', () => {
        const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                initialSchedule="0 9 * * *"
                initialNextRunAt={past}
            />,
        );

        const tone = screen.getByTestId('test-plan-next-run-tone');
        expect(tone.dataset.tone).toBe('overdue');
        expect(tone).toHaveTextContent('Overdue');
    });

    test('today tone when nextRunAt is within 24 hours', () => {
        const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                initialSchedule="0 9 * * *"
                initialNextRunAt={soon}
            />,
        );

        const tone = screen.getByTestId('test-plan-next-run-tone');
        expect(tone.dataset.tone).toBe('today');
        expect(tone).toHaveTextContent('Today');
    });

    test('normal tone when nextRunAt is in the future', () => {
        const later = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                initialSchedule="0 9 * * MON"
                initialNextRunAt={later}
            />,
        );

        const tone = screen.getByTestId('test-plan-next-run-tone');
        expect(tone.dataset.tone).toBe('normal');
        expect(tone).toHaveTextContent('Next run');
    });

    test('shows automationType label when not MANUAL', () => {
        const later = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="INTEGRATION"
                initialSchedule="0 9 * * *"
                initialNextRunAt={later}
            />,
        );
        expect(screen.getByText(/Automation: INTEGRATION/)).toBeInTheDocument();
    });
});

// ─── 3. Saving via the schedule API ────────────────────────────────

describe('TestPlanScheduleSection — save interaction', () => {
    test('changing cadence to Daily triggers PUT with cron + MANUAL (PR-P)', async () => {
        const onSaved = jest.fn();
        const user = userEvent.setup();

        render(
            <TestPlanScheduleSection {...BASE_PROPS} onSaved={onSaved} />,
        );

        // Save button hidden until dirty — confirm.
        expect(
            screen.queryByRole('button', { name: /Save schedule/i }),
        ).not.toBeInTheDocument();

        // Open the cadence picker and select "Daily at 09:00".
        await user.click(
            screen.getByRole('combobox'),
        );
        await user.click(
            screen.getByRole('option', { name: /Daily at 09:00/i }),
        );

        // Save button now visible.
        const saveBtn = screen.getByRole('button', {
            name: /Save schedule/i,
        });
        expect(saveBtn).toBeEnabled();
        await user.click(saveBtn);

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledTimes(1);
        });

        const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
            string,
            RequestInit,
        ];
        expect(url).toBe('/api/t/acme/tests/plans/plan-1/schedule');
        expect(init.method).toBe('PUT');

        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({
            schedule: '0 9 * * *',
            // PR-P — a cadence is now a MANUAL plan on a schedule (each tick
            // instantiates a PLANNED "awaiting manual completion" run). We no
            // longer force the misleading SCRIPT label when no engine exists.
            automationType: 'MANUAL',
        });
        // Timezone is auto-detected; just assert it's a non-empty string.
        expect(typeof body.scheduleTimezone).toBe('string');
        expect(body.scheduleTimezone.length).toBeGreaterThan(0);

        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    });

    test('selecting Off (manual) sends MANUAL + null schedule', async () => {
        const user = userEvent.setup();
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                initialSchedule="0 9 * * *"
                initialScheduleTimezone="UTC"
                initialNextRunAt={new Date(Date.now() + 3600_000).toISOString()}
            />,
        );

        await user.click(screen.getByRole('combobox'));
        await user.click(
            screen.getByRole('option', { name: /Off \(manual\)/i }),
        );
        await user.click(screen.getByRole('button', { name: /Save schedule/i }));

        await waitFor(() => expect(global.fetch).toHaveBeenCalled());
        const body = JSON.parse(
            ((global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit])[1]
                .body as string,
        );
        expect(body).toMatchObject({
            schedule: null,
            scheduleTimezone: null,
            automationType: 'MANUAL',
        });
    });

    test('API error surfaces inline without calling onSaved', async () => {
        global.fetch = jest.fn().mockResolvedValue(
            fakeError(400, { error: 'Invalid cron' }),
        );
        const onSaved = jest.fn();
        const user = userEvent.setup();
        render(
            <TestPlanScheduleSection {...BASE_PROPS} onSaved={onSaved} />,
        );

        await user.click(screen.getByRole('combobox'));
        await user.click(
            screen.getByRole('option', { name: /Daily at 09:00/i }),
        );
        await user.click(screen.getByRole('button', { name: /Save schedule/i }));

        await waitFor(() => {
            expect(
                screen.getByTestId('test-plan-schedule-error'),
            ).toBeInTheDocument();
        });
        expect(screen.getByTestId('test-plan-schedule-error')).toHaveTextContent(
            /Invalid cron/,
        );
        expect(onSaved).not.toHaveBeenCalled();
    });
});

// ─── 4. Permission gating ──────────────────────────────────────────

describe('TestPlanScheduleSection — permission gating', () => {
    test('canEdit=false hides save button + shows read-only message', () => {
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                initialSchedule="0 9 * * *"
                canEdit={false}
            />,
        );

        // No save button can ever appear when canEdit is false —
        // even after a hypothetical click on the disabled picker.
        expect(
            screen.queryByRole('button', { name: /Save schedule/i }),
        ).not.toBeInTheDocument();

        // Read-only copy is shown so the user understands why the
        // controls are inert.
        expect(
            screen.getByText(/don.+t have permission/i),
        ).toBeInTheDocument();
    });
});

// ─── 5. Custom-schedule guard ──────────────────────────────────────

describe('TestPlanScheduleSection — custom schedule warning', () => {
    test('renders an explanatory warning when stored cron is outside the catalog', () => {
        render(
            <TestPlanScheduleSection
                {...BASE_PROPS}
                initialAutomationType="SCRIPT"
                // Not in the cadence catalog.
                initialSchedule="*/13 * * * *"
                initialScheduleTimezone="UTC"
                initialNextRunAt={new Date(Date.now() + 3600_000).toISOString()}
            />,
        );

        expect(
            screen.getByTestId('test-plan-custom-schedule-warning'),
        ).toBeInTheDocument();
        // The warning explicitly mentions overwriting so the user
        // knows what choosing a catalog cadence will do.
        const warning = screen.getByTestId(
            'test-plan-custom-schedule-warning',
        );
        expect(warning).toHaveTextContent(/overwrite/i);
    });
});
