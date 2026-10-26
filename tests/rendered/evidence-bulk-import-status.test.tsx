/**
 * The ZIP import's status line names the job's state in words (#4277).
 *
 * It printed BullMQ's raw state ("waiting", "active", "completed",
 * "failed") after the internal job id. Neither means anything to the person
 * running the import, so the line now reads "Status: Running" and so on,
 * from the catalogue, with no id.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    // One function per namespace, as next-intl's is stable: the poll loop's
    // effect depends on `tx`, and a fresh identity per render restarts it.
    const cache = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) {
                cache.set(ns, (key, values) => {
                    const v = walk(walk(en, ns), key);
                    if (typeof v !== 'string') return key;
                    return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
                });
            }
            return cache.get(ns)!;
        },
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/evidence',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/ui/entity-picker', () => ({ EntityPicker: () => null }));

// The dropzone is exercised by its own suites; here it only has to hand the
// modal one archive when the form is submitted.
jest.mock('@/components/ui/FileDropzone', () => {
    const React = require('react');
    return {
        FileDropzone: React.forwardRef(function FakeDropzone(
            props: { onPick?: (f: File[]) => void; onUpload: (f: File, c: unknown) => Promise<unknown> },
            ref: React.Ref<unknown>,
        ) {
            const file = new File(['zip'], 'pack.zip', { type: 'application/zip' });
            React.useImperativeHandle(ref, () => ({
                startAll: () =>
                    props.onUpload(file, { onProgress: () => {}, signal: new AbortController().signal }),
                cancelAll: () => {},
                getEntries: () => [],
            }));
            return (
                <button type="button" id="fake-pick" onClick={() => props.onPick?.([file])}>
                    pick
                </button>
            );
        }),
    };
});

jest.mock('@/lib/upload/upload-with-progress', () => ({
    uploadWithProgress: jest.fn(async () => ({ jobId: 'job-8f2c41' })),
    UploadHttpError: class extends Error {},
}));

import { SWRConfig } from 'swr';
import { EvidenceBulkImportModal } from '@/app/t/[tenantSlug]/(app)/evidence/EvidenceBulkImportModal';

const EN = require('../../messages/en.json');
const apiUrl = (p: string) => `/api/t/acme${p}`;

function pollAnswers(state: string) {
    global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ jobId: 'job-8f2c41', state, progress: { extracted: 1, skipped: 0, errored: 0, totalEntries: 2 } }),
    })) as unknown as typeof fetch;
}

async function startImport() {
    render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <EvidenceBulkImportModal
                open
                setOpen={() => {}}
                tenantSlug="acme"
                apiUrl={apiUrl}
                canEditControlLinks
            />
        </SWRConfig>,
    );
    fireEvent.click(await screen.findByText('pick'));
    await act(async () => {
        fireEvent.click(document.getElementById('bulk-import-submit-btn')!);
    });
}

describe('ZIP import status line', () => {
    it.each([
        ['active', EN.evidence.bulkImport.states.running],
        ['waiting', EN.evidence.bulkImport.states.queued],
        ['completed', EN.evidence.bulkImport.states.completed],
        ['failed', EN.evidence.bulkImport.states.failed],
    ])('state %s reads "%s", with no raw state and no job id', async (state, label) => {
        pollAnswers(state);
        await startImport();
        const line = await screen.findByText(
            EN.evidence.bulkImport.statusLine.replace('{state}', label),
        );
        await waitFor(() =>
            expect(line).toHaveTextContent(EN.evidence.bulkImport.statusLine.replace('{state}', label)),
        );
        const status = screen.getByTestId('evidence-bulk-import-status');
        expect(status.textContent).not.toContain('job-8f2c41');
        expect(document.getElementById('bulk-import-state')!.textContent).not.toMatch(
            new RegExp(`\\b${state}\\b`),
        );
    });
});
