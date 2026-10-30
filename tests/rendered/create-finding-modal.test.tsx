/**
 * `<CreateFindingModal>` — behavioural render lock.
 *
 * Asserts the create-finding modal exposes the full field set the feature
 * requires (title, type, severity, assignee, due date, description, linked
 * control, compensating control, implicated risks, analysis) and that the
 * submit button gates on the required title + description.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/findings',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so text assertions track the original English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

// The modal's dropdowns now read via `useTenantSWR`, which resolves the
// tenant-relative path through `useTenantApiUrl`. Mock that seam (mirrors
// the evidence-upload-optimistic harness) so no TenantProvider is required.
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { CreateFindingModal } from '@/app/t/[tenantSlug]/(app)/findings/CreateFindingModal';

beforeEach(() => {
    // Every lookup (controls / risks / assignable members) resolves empty.
    global.fetch = jest.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
    ) as unknown as typeof fetch;
});

function renderModal() {
    const apiUrl = (p: string) => `/api/t/acme${p}`;
    // Fresh per-test SWR cache. (React Query fully removed — the modal's
    // dropdowns + nested <UserCombobox> read via useSWR now.)
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <CreateFindingModal open setOpen={() => {}} tenantSlug="acme" apiUrl={apiUrl} />
        </SWRConfig>,
    );
}

const FIELD_IDS = [
    'finding-title',
    'finding-type',
    'finding-severity',
    'finding-assignee',
    'finding-description',
    'finding-control',
    'finding-compensating-control',
    'finding-analysis',
    'submit-finding',
];

describe('CreateFindingModal', () => {
    it('renders every required field + the risks linker', async () => {
        renderModal();
        for (const id of FIELD_IDS) {
            await waitFor(() => expect(document.getElementById(id)).not.toBeNull());
        }
        // Due-date picker (DatePicker doesn't surface its id in jsdom) +
        // the risks linker.
        expect(screen.getByText('Due date')).not.toBeNull();
        expect(screen.getByTestId('finding-risks-list')).not.toBeNull();
    });

    it('disables submit until title AND description are filled', async () => {
        renderModal();
        const submit = await waitFor(() => {
            const el = document.getElementById('submit-finding');
            if (!el) throw new Error('no submit');
            return el as HTMLButtonElement;
        });
        expect(submit).toBeDisabled();

        fireEvent.change(document.getElementById('finding-title')!, { target: { value: 'A finding' } });
        expect(submit).toBeDisabled(); // description still empty

        fireEvent.change(document.getElementById('finding-description')!, {
            target: { value: 'What was observed' },
        });
        await waitFor(() => expect(submit).not.toBeDisabled());
    });

    // #4461 — the API's error envelope is `{ error: { code, message } }`. The
    // dialog read `data.message || data.error`, handed the OBJECT to
    // `new Error()`, and showed every refusal as "[object Object]".
    it("shows the server's refusal, not [object Object]", async () => {
        const REFUSAL = 'You do not have permission to modify records in this context.';
        global.fetch = jest.fn((_url: string, init?: RequestInit) =>
            Promise.resolve(
                init?.method === 'POST'
                    ? {
                          ok: false,
                          status: 403,
                          json: () => Promise.resolve({ error: { code: 'FORBIDDEN', message: REFUSAL } }),
                      }
                    : { ok: true, json: () => Promise.resolve([]) },
            ),
        ) as unknown as typeof fetch;
        renderModal();
        await waitFor(() => expect(document.getElementById('finding-title')).not.toBeNull());
        fireEvent.change(document.getElementById('finding-title')!, { target: { value: 'A finding' } });
        fireEvent.change(document.getElementById('finding-description')!, {
            target: { value: 'What was observed' },
        });
        const submit = document.getElementById('submit-finding') as HTMLButtonElement;
        await waitFor(() => expect(submit).not.toBeDisabled());
        fireEvent.click(submit);
        const alert = await screen.findByTestId('create-finding-error');
        expect(alert).toHaveTextContent(REFUSAL);
        expect(alert).not.toHaveTextContent('[object Object]');
    });

    it('falls back to the status line when the server gives no reason', async () => {
        global.fetch = jest.fn((_url: string, init?: RequestInit) =>
            Promise.resolve(
                init?.method === 'POST'
                    ? { ok: false, status: 500, json: () => Promise.reject(new Error('no body')) }
                    : { ok: true, json: () => Promise.resolve([]) },
            ),
        ) as unknown as typeof fetch;
        renderModal();
        await waitFor(() => expect(document.getElementById('finding-title')).not.toBeNull());
        fireEvent.change(document.getElementById('finding-title')!, { target: { value: 'A finding' } });
        fireEvent.change(document.getElementById('finding-description')!, {
            target: { value: 'What was observed' },
        });
        const submit = document.getElementById('submit-finding') as HTMLButtonElement;
        await waitFor(() => expect(submit).not.toBeDisabled());
        fireEvent.click(submit);
        expect(await screen.findByTestId('create-finding-error')).toHaveTextContent(
            'Failed to create finding (500)',
        );
    });

    // Regression lock — the controls lookup must unwrap the backfill-capped
    // `{ rows, truncated }` response shape that GET /controls returns. The
    // pre-fix bare-`Array.isArray` guard fell through to `[]`, so the control
    // picker was permanently EMPTY and a finding could never be linked to a
    // control at create time. Asserted at the source so it's deterministic
    // (cmdk option rendering is awkward to drive in jsdom).
    it('controls lookup unwraps the CappedList { rows } shape (not bare-array-only)', () => {
        const src = fs.readFileSync(
            path.resolve(
                __dirname,
                '../../src/app/t/[tenantSlug]/(app)/findings/CreateFindingModal.tsx',
            ),
            'utf-8',
        );
        // Extract just the controls memo block so the assertion can't be
        // satisfied by the sibling risks memo (which has the same unwrap).
        const controlsMemo =
            src.match(
                /const controls = useMemo<ControlOption\[\]>\(\(\) => \{[\s\S]*?\}, \[controlsQuery\.data\]\)/,
            )?.[0] ?? '';
        expect(controlsMemo).not.toBe('');
        // Must read `data?.rows` (cap shape), mirroring the risks memo.
        expect(controlsMemo).toMatch(
            /Array\.isArray\(data\)\s*\?\s*data\s*:\s*\(data\?\.rows\s*\?\?\s*\[\]\)/,
        );
        // And must NOT regress to the empty-on-cap-shape guard.
        expect(controlsMemo).not.toMatch(
            /if \(!Array\.isArray\(data\)\) return \[\];/,
        );
    });
});
