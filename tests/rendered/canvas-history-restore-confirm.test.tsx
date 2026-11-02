/**
 * Restoring a process-map version asks in the app's confirm dialog (#4989).
 *
 * It used the browser's own `confirm()`: a box unlike every other confirmation
 * in the product, labelled by the browser, and one a browser can offer to
 * suppress — after which the restore ran with no question at all.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/processes',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { CanvasHistorySidebar } from '@/components/processes/CanvasHistorySidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

const SNAPSHOTS = [
    { id: 's3', version: 3, createdAt: '2026-10-01T00:00:00.000Z', createdByName: 'Ana' },
    { id: 's2', version: 2, createdAt: '2026-09-01T00:00:00.000Z', createdByName: 'Ana' },
];

let fetchMock: jest.Mock;

beforeEach(() => {
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return { ok: true, status: 200, json: async () => ({ version: 4 }) };
        return { ok: true, status: 200, json: async () => ({ snapshots: SNAPSHOTS }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
});

const restorePosts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

function mount(onRestored = jest.fn()) {
    render(
        <TooltipProvider>
            <CanvasHistorySidebar tenantSlug="acme" mapId="map-1" currentVersion={3} onRestored={onRestored} />
        </TooltipProvider>,
    );
    return onRestored;
}

/** The dialog's button with this label (the modal renders its title twice). */
function dialogButton(label: string): HTMLElement {
    const buttons = Array.from(document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button'));
    const button = buttons.find((b) => b.textContent === label);
    if (!button) throw new Error(`no "${label}" button in a dialog`);
    return button as HTMLElement;
}

async function clickRestoreOnVersion2() {
    const buttons = await screen.findAllByTestId('canvas-history-restore');
    // Rows are newest first; v2 is the second.
    fireEvent.click(buttons[buttons.length - 1]!);
}

describe('restoring a version', () => {
    it('opens the confirm dialog and sends nothing until it is confirmed', async () => {
        const confirmSpy = jest.spyOn(window, 'confirm');
        const onRestored = mount();
        await clickRestoreOnVersion2();

        expect((await screen.findAllByText('Restore version 2?')).length).toBeGreaterThan(0);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(restorePosts()).toHaveLength(0);

        fireEvent.click(dialogButton('Restore'));

        await waitFor(() => expect(restorePosts()).toHaveLength(1));
        expect(String(restorePosts()[0][0])).toContain('/snapshots/2/restore');
        await waitFor(() => expect(onRestored).toHaveBeenCalled());
        confirmSpy.mockRestore();
    });

    it('Cancel restores nothing', async () => {
        mount();
        await clickRestoreOnVersion2();
        await screen.findAllByText('Restore version 2?');
        fireEvent.click(dialogButton('Cancel'));
        await waitFor(() => expect(screen.queryAllByText('Restore version 2?')).toHaveLength(0));
        expect(restorePosts()).toHaveLength(0);
    });
});
