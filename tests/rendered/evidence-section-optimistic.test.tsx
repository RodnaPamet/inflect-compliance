/**
 * EvidenceUploadSection — a just-uploaded file shows IMMEDIATELY and survives a
 * momentarily-stale list refetch.
 *
 * This is the control-rail bug: the upload commits, but the control evidence
 * list GET could lag (read-after-write) and return without the new row, so the
 * refetch would wipe it. The section now inserts the upload's 201 response
 * optimistically (keyed by the real Evidence id) and merges it on refetch — so
 * an empty/stale GET can't hide the row.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const uploadMock = jest.fn();
jest.mock('@/lib/upload/upload-with-progress', () => ({
    uploadWithProgress: (...args: unknown[]) => uploadMock(...args),
    UploadHttpError: class extends Error {},
    UploadAbortedError: class extends Error {},
}));

import { EvidenceUploadSection } from '@/components/evidence/EvidenceUploadSection';

function dropFiles(target: HTMLElement, files: File[]) {
    const dataTransfer = {
        files,
        items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
        types: ['Files'],
    };
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
}

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

describe('EvidenceUploadSection optimistic upload', () => {
    it('shows the uploaded file even when the refetch GET returns an empty list', async () => {
        // Every list GET returns EMPTY — simulates control read-after-write lag.
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ evidence: [], links: [] }),
        });
        // The upload POST resolves with the created Evidence row (201 body).
        uploadMock.mockResolvedValue({
            id: 'ev-new',
            title: 'report.pdf',
            fileName: 'report.pdf',
            fileRecordId: 'F1',
            type: 'FILE',
        });

        render(
            <EvidenceUploadSection
                tenantSlug="acme"
                linkField="controlId"
                linkId="c1"
                canWrite
                listEndpoint="/controls/c1/evidence"
            />,
        );

        const zone = await screen.findByTestId('evidence-upload-dropzone');
        const file = new File(['x'], 'report.pdf', { type: 'application/pdf' });
        await act(async () => {
            dropFiles(zone, [file]);
        });

        // The row appears (from the 201) and is NOT wiped by the empty refetch.
        await waitFor(() => {
            expect(screen.getByTestId('evidence-attached-link')).toHaveTextContent('report.pdf');
        });
        expect(screen.getByTestId('evidence-attached-link')).toHaveAttribute(
            'href',
            '/api/t/acme/evidence/files/F1/download',
        );
    });

    it('does not duplicate the row once the server list catches up', async () => {
        // First GET (mount) empty; after upload the GET returns the real row.
        fetchMock
            .mockResolvedValueOnce({ ok: true, json: async () => ({ evidence: [], links: [] }) })
            .mockResolvedValue({
                ok: true,
                json: async () => ({
                    evidence: [
                        { id: 'ev-new', title: 'report.pdf', fileName: 'report.pdf', fileRecordId: 'F1', type: 'FILE' },
                    ],
                    links: [
                        // The control upload-bridge duplicate — must be deduped.
                        { id: 'lnk-1', kind: 'FILE', fileId: 'F1', note: 'report.pdf' },
                    ],
                }),
            });
        uploadMock.mockResolvedValue({
            id: 'ev-new',
            title: 'report.pdf',
            fileName: 'report.pdf',
            fileRecordId: 'F1',
            type: 'FILE',
        });

        render(
            <EvidenceUploadSection
                tenantSlug="acme"
                linkField="controlId"
                linkId="c1"
                canWrite
                listEndpoint="/controls/c1/evidence"
            />,
        );

        const zone = await screen.findByTestId('evidence-upload-dropzone');
        await act(async () => {
            dropFiles(zone, [new File(['x'], 'report.pdf', { type: 'application/pdf' })]);
        });

        await waitFor(() => {
            expect(screen.getAllByTestId('evidence-attached-link')).toHaveLength(1);
        });
        expect(screen.getByTestId('evidence-attached-link')).toHaveTextContent('report.pdf');
    });
});

describe('EvidenceUploadSection attached links (#5309)', () => {
    it('renders a dangerous-scheme address as text, never as a link', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                evidence: [],
                links: [
                    { id: 'l-bad', kind: 'LINK', url: 'javascript:alert(1)', note: 'Bad link' },
                    { id: 'l-good', kind: 'LINK', url: 'https://example.com/report', note: 'Good link' },
                ],
            }),
        });
        render(
            <EvidenceUploadSection
                tenantSlug="acme"
                linkField="taskId"
                linkId="t1"
                canWrite
                listEndpoint="/tasks/t1/evidence"
            />,
        );

        const good = await screen.findByText('Good link');
        expect(good.closest('a')).toHaveAttribute('href', 'https://example.com/report');
        const bad = screen.getByText('Bad link');
        expect(bad.closest('a')).toBeNull();
        expect(screen.getAllByTestId('evidence-attached-link')).toHaveLength(1);
    });
});
