/** @jest-environment jsdom */

/**
 * #4641 — the PDF export button reports with toasts, and a refusal says why.
 *
 * It called `alert()` on success and on every failure, and the failure alert
 * said only "Failed to generate PDF" — the route's named refusals (no
 * `reports.export`, a plan without PDF exports) were logged and never shown.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        success: (...a: unknown[]) => toastSuccess(...a),
        error: (...a: unknown[]) => toastError(...a),
        info: jest.fn(), warning: jest.fn(), dismiss: jest.fn(), custom: jest.fn(), message: jest.fn(), loading: jest.fn(),
    }),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        const val = lookup(ns, key);
        if (typeof val !== 'string') return key;
        return val.replace(/\{(\w+)\}/g, (m: string, name: string) =>
            params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
        );
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

import { TooltipProvider } from '@/components/ui/tooltip';
import { PdfExportButton } from '@/components/PdfExportButton';

const PDF = jest.requireActual('../../messages/en.json').panels.pdf;

const alertSpy = jest.fn();
const fetchMock = jest.fn();
beforeEach(() => {
    toastSuccess.mockReset();
    toastError.mockReset();
    fetchMock.mockReset();
    alertSpy.mockReset();
    window.alert = alertSpy;
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function mount() {
    return render(
        <TooltipProvider>
            <PdfExportButton tenantSlug="acme" reportType="GAP_ANALYSIS" allowSave />
        </TooltipProvider>,
    );
}

async function click(id: string) {
    await act(async () => {
        fireEvent.click(document.getElementById(id) as HTMLElement);
    });
}

describe('PdfExportButton (#4641)', () => {
    it("shows the server's reason when the export is refused, as a toast", async () => {
        fetchMock.mockResolvedValue({
            ok: false, status: 403,
            json: async () => ({ error: { code: 'FORBIDDEN', message: 'Feature "PDF exports" requires the PRO plan or higher. Current plan: FREE.' } }),
        });
        mount();
        await click('export-pdf-gap_analysis-btn');
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(toastError.mock.calls[0][0]).toBe('Feature "PDF exports" requires the PRO plan or higher. Current plan: FREE.');
        expect(alertSpy).not.toHaveBeenCalled();
        // The button is usable again.
        expect(screen.getByText(PDF.export)).toBeTruthy();
    });

    it('falls back to the fixed sentence for a refusal with no reason, and for a network failure', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
        mount();
        await click('export-pdf-gap_analysis-btn');
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
        expect(toastError.mock.calls[0][0]).toBe(PDF.failed);

        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await click('export-pdf-gap_analysis-btn');
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2));
        expect(toastError.mock.calls[1][0]).toBe(PDF.failed);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('confirms a saved evidence file with a toast, on one line', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ fileName: 'gap.pdf', sizeBytes: 2048 }) });
        mount();
        await click('save-pdf-gap_analysis-btn');
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
        expect(toastSuccess.mock.calls[0][0]).toBe(
            PDF.saved.replace('{fileName}', 'gap.pdf').replace('{size}', '2.0'),
        );
        expect(toastSuccess.mock.calls[0][0]).not.toContain('\n');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ type: 'GAP_ANALYSIS', saveToFileRecord: true });
        expect(alertSpy).not.toHaveBeenCalled();
    });
});
