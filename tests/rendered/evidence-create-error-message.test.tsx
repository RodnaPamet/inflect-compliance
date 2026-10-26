/**
 * A refused evidence create shows the SERVER's reason (#4126).
 *
 * Every API error body is the envelope `{ error: { code, message } }`.
 * These surfaces did `new Error(err.error || err.message || fallback)`,
 * which handed the envelope OBJECT to `new Error`, so the user read
 * "[object Object]". They now go through `apiErrorMessage`.
 *
 *   - the evidence library's "Create link" dialog
 *   - the evidence library's text-evidence dialog
 *   - the drag-and-drop section's "Link URL" (controls list edit panel,
 *     task panel)
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

// The shared <Modal> reads the app router.
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

import { NewEvidenceLinkModal } from '@/app/t/[tenantSlug]/(app)/evidence/NewEvidenceLinkModal';
import { NewEvidenceTextModal } from '@/app/t/[tenantSlug]/(app)/evidence/NewEvidenceTextModal';
import { EvidenceUploadSection } from '@/components/evidence/EvidenceUploadSection';

const REASON = 'You do not have permission to edit evidence.';

const fetchMock = jest.fn();
function json(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response;
}
const refused = () => json({ error: { code: 'FORBIDDEN', message: REASON } }, 403);

beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

const apiUrl = (p: string) => `/api/t/acme${p}`;

function withSWR(ui: React.ReactNode) {
    return <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>;
}

const byId = (id: string) => document.getElementById(id) as HTMLInputElement;

describe('evidence library — Create link dialog', () => {
    it("shows the server's reason, not [object Object]", async () => {
        fetchMock.mockResolvedValue(refused());
        render(withSWR(
            <NewEvidenceLinkModal open setOpen={() => {}} tenantSlug="acme" apiUrl={apiUrl} controls={[]} canEditControlLinks />,
        ));
        fireEvent.change(byId('link-evidence-title-input'), { target: { value: 'Q3 review' } });
        fireEvent.change(byId('link-evidence-url-input'), { target: { value: 'https://example.com/r' } });
        await act(async () => {
            fireEvent.submit(byId('link-evidence-form'));
        });
        const box = await screen.findByTestId('link-evidence-error');
        expect(box).toHaveTextContent(REASON);
        expect(box).not.toHaveTextContent('[object Object]');
    });
});

describe('evidence library — text evidence dialog', () => {
    it("shows the server's reason, not [object Object]", async () => {
        fetchMock.mockResolvedValue(refused());
        render(withSWR(
            <NewEvidenceTextModal open setOpen={() => {}} tenantSlug="acme" apiUrl={apiUrl} controls={[]} canEditControlLinks />,
        ));
        fireEvent.change(byId('text-evidence-title-input'), { target: { value: 'Board minutes' } });
        await act(async () => {
            fireEvent.submit(byId('text-evidence-form'));
        });
        const box = await screen.findByTestId('text-evidence-error');
        expect(box).toHaveTextContent(REASON);
        expect(box).not.toHaveTextContent('[object Object]');
    });
});

describe('drag-and-drop evidence section — Link URL', () => {
    it("shows the server's reason, not [object Object]", async () => {
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
            init?.method === 'POST' ? refused() : json({ evidence: [], links: [] }),
        );
        render(
            <EvidenceUploadSection
                tenantSlug="acme"
                linkField="controlId"
                linkId="c1"
                canWrite
                urlLinkEndpoint="/controls/c1/evidence"
            />,
        );
        fireEvent.change(screen.getByTestId('evidence-link-url'), {
            target: { value: 'https://example.com/r' },
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('evidence-link-url-submit'));
        });
        await waitFor(() => expect(screen.getByText(REASON)).toBeInTheDocument());
        expect(screen.queryByText('[object Object]')).toBeNull();
    });
});
