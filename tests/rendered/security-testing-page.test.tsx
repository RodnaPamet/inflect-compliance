/** @jest-environment jsdom */

/**
 * #4631 — the Security Testing page reads in words, counts open critical
 * findings over all of them, says when the list is cut short, and shows why an
 * upload or a status change was refused.
 */
import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: (...a: unknown[]) => toastError(...a), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

// The repo-wide mock substitutes `{name}` only, which would leave the header's
// `{critical, plural, …}` as a template — so a count assertion would be on a
// template. This one also evaluates the flat plural blocks the catalogue uses.
// Memoised per namespace so `useMemo([t])` downstream does not loop.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (params: Record<string, unknown> | undefined, name: string) =>
        !!params && Object.prototype.hasOwnProperty.call(params, name);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)(?:,\s*number)?\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            return typeof val === 'string' ? format(val, params) : key;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => typeof lookup(ns, k) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh, back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/security-testing',
    useSearchParams: () => new URLSearchParams(),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import {
    SecurityTestingClient,
    type ScannerFindingRow,
    type ScannerRunRow,
} from '@/app/t/[tenantSlug]/(app)/security-testing/SecurityTestingClient';

const FINDINGS: ScannerFindingRow[] = [{
    id: 'sf-1', fingerprint: 'fp-1', ruleId: 'aws-key', severity: 'CRITICAL', title: 'Hard-coded AWS key',
    description: null, location: 'src/config.ts:4', cweIds: [], status: 'OPEN',
    scannerRun: { source: 'GITLEAKS', scanType: 'SECRETS', ranAt: '2026-10-01T00:00:00.000Z' },
    frameworks: { owasp: [], ssdf: [] },
}];
const RUNS: ScannerRunRow[] = [{
    id: 'run-1', source: 'GITLEAKS', scanType: 'SECRETS', ranAt: '2026-10-01T00:00:00.000Z',
    outcome: 'PASS', repoRef: null, findingCount: 1, ingestedVia: 'UPLOAD',
}];

function mount(opts: { truncated?: boolean; openCritical?: number; canWrite?: boolean } = {}) {
    return render(
        <TooltipProvider>
            <SecurityTestingClient
                initialFindings={FINDINGS}
                findingsTruncated={opts.truncated ?? false}
                openCriticalCount={opts.openCritical ?? 1}
                runs={RUNS}
                tenantSlug="acme"
                canWrite={opts.canWrite ?? false}
            />
        </TooltipProvider>,
    );
}

const fetchMock = jest.fn();
beforeEach(() => {
    toastError.mockReset();
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

describe('Security Testing — words, not codes (#4631)', () => {
    it('labels severity, scan type, run outcome and how a run arrived', () => {
        const { container } = mount();
        const text = container.textContent ?? '';
        for (const word of ['Critical', 'Secrets', 'Passed', 'Upload']) expect(text).toContain(word);
        for (const code of ['CRITICAL', 'SECRETS', 'PASS', 'UPLOAD']) expect(text).not.toContain(code);
    });

    it("counts open critical findings from the server's count, not the rows on the page", () => {
        const { container } = mount({ openCritical: 37 });
        expect(container.textContent).toContain('37 open critical findings');
    });

    it('says when there are more findings than it shows', () => {
        const { getByTestId, rerender, queryByTestId } = mount({ truncated: true });
        expect(getByTestId('list-truncation-banner').textContent).toContain('The most severe are shown first');
        rerender(
            <TooltipProvider>
                <SecurityTestingClient initialFindings={FINDINGS} findingsTruncated={false} openCriticalCount={1} runs={RUNS} tenantSlug="acme" canWrite={false} />
            </TooltipProvider>,
        );
        expect(queryByTestId('list-truncation-banner')).toBeNull();
    });
});

describe('Security Testing — refusals say why (#4631)', () => {
    it("names the parser's reason when an upload is not valid SARIF", async () => {
        fetchMock.mockResolvedValue({
            ok: false, status: 400,
            json: async () => ({ error: { code: 'VALIDATION_ERROR', message: 'INVALID_SARIF', details: 'sarif: runs[] missing' } }),
        });
        const { container } = mount({ canWrite: true });
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['{"version":"2.1.0"}'], 'scan.sarif', { type: 'application/json' });
        Object.defineProperty(file, 'text', { value: async () => '{"version":"2.1.0"}' });
        await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastError.mock.calls[0][0]).toBe('The file is not a valid SARIF report: sarif: runs[] missing');
    });

    it("shows the server's message when an upload is refused for another reason", async () => {
        fetchMock.mockResolvedValue({
            ok: false, status: 403,
            json: async () => ({ error: { code: 'FORBIDDEN', message: 'You do not have permission to ingest scans.' } }),
        });
        const { container } = mount({ canWrite: true });
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['{}'], 'scan.sarif', { type: 'application/json' });
        Object.defineProperty(file, 'text', { value: async () => '{}' });
        await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastError.mock.calls[0][0]).toBe('You do not have permission to ingest scans.');
    });
});
