/**
 * The asset CSV importer, executed (#4276).
 *
 * Three defects, each one a sentence the page told the user that was not
 * true, and each one invisible to a source scan because the false sentence
 * and the true code looked unrelated in the file:
 *
 *   1. The format text listed Type under "Optional columns" while the parser
 *      refused every row without one — and it omitted Location, which the
 *      importer reads and the example row carries. Both halves are DERIVED
 *      here from the page itself: which columns the importer actually
 *      requires (by blanking each one in the page's own example row), and
 *      which columns the example shows.
 *   2. A refused bulk request (the server's 500-row cap, say) still rendered
 *      "Import complete — 0 of N assets created" in success colour.
 *   3. The page gated on the coarse write tier only, which a custom role
 *      takes from its BASE role, while the import route checks
 *      `assets.create`.
 */
import * as React from 'react';
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PermissionSet } from '@/lib/permissions';

jest.setTimeout(120_000);
configure({ asyncUtilTimeout: 15_000 });

let currentPermissions = { canRead: true, canWrite: true, canAdmin: true, canAudit: false, canExport: true };
let currentAppPermissions: PermissionSet | undefined;

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}`,
    useTenantHref: () => (p: string) => `/t/acme${p}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        tenantName: 'Acme',
        permissions: currentPermissions,
        appPermissions: currentAppPermissions,
    }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const v = walk(walk(en, ns), key);
            if (typeof v !== 'string') return key;
            let s = v;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return s;
        };
        t.rich = (key: string) => walk(walk(en, ns), key) ?? key;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => {
    const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() };
    const searchParams = new URLSearchParams();
    return {
        useRouter: () => router,
        usePathname: () => '/t/acme/assets/import',
        useSearchParams: () => searchParams,
        useParams: () => ({ tenantSlug: 'acme' }),
    };
});

import AssetImportPage from '@/app/t/[tenantSlug]/(app)/assets/import/page';
import { getPermissionsForRole } from '@/lib/permissions';
import { makeRequestContext } from '../helpers/make-context';
import type { Role } from '@prisma/client';

const en = require('../../messages/en.json');
const IMPORT = en.assets.import;

function mountAs(role: Role, app?: (p: PermissionSet) => PermissionSet) {
    currentPermissions = makeRequestContext(role).permissions;
    const base = getPermissionsForRole(role);
    currentAppPermissions = app ? app(base) : base;
    return render(<AssetImportPage />);
}

/** The page's own example CSV — header + row — read off the rendered `<pre>`. */
function exampleCsv(): { header: string[]; row: string } {
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    const [headerLine, rowLine] = (pre!.textContent ?? '').trim().split('\n');
    return { header: headerLine.split(','), row: rowLine };
}

/**
 * Upload `csv` and return row 1's status cell — "Valid" or the row's error.
 *
 * The FileReader resolves asynchronously and the PREVIOUS preview stays on
 * screen until it does, so reading the status straight after a re-upload
 * would read the last file's answer. Each upload therefore carries a row
 * name of its own, and the read waits until the preview shows that name.
 */
async function uploadAndReadStatus(csv: string, expectedName: string): Promise<string> {
    const input = document.getElementById('csv-file-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File([csv], 'assets.csv', { type: 'text/csv' });
    await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
    });
    return waitFor(() => {
        const preview = document.getElementById('asset-import-preview');
        expect(preview).not.toBeNull();
        const rows = within(preview as HTMLElement).getAllByRole('row');
        // rows[0] is the header row. Cells are located by their column
        // header, not by position — the table prepends a utility column.
        expect(rows.length).toBeGreaterThan(1);
        const headers = within(rows[0]).getAllByRole('columnheader').map((h) => (h.textContent ?? '').trim());
        const cells = within(rows[1]).getAllByRole('cell');
        expect(cells).toHaveLength(headers.length);
        const at = (label: string) => (cells[headers.indexOf(label)].textContent ?? '').trim();
        expect(at(IMPORT.colName)).toBe(expectedName);
        return at(IMPORT.colStatus);
    });
}

function respond(status: number, body: unknown) {
    global.fetch = jest.fn(async () => ({
        ok: status < 400,
        status,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
}

beforeEach(() => {
    respond(200, { created: 1, skipped: 0, errors: [], skippedRows: [] });
});

describe('Asset import — the format text describes the importer', () => {
    it('names every column the example row carries', () => {
        mountAs('EDITOR');
        const desc = screen.getByText(IMPORT.csvDesc).textContent ?? '';
        const missing = exampleCsv().header.filter(
            (col) => !new RegExp(`\\b${col}\\b`).test(desc),
        );
        // Location was read by the parser and shown in the example, and was
        // the one column the text never mentioned.
        expect(missing).toEqual([]);
    });

    it('calls a column optional only if a row without it imports', async () => {
        mountAs('EDITOR');
        const desc = screen.getByText(IMPORT.csvDesc).textContent ?? '';
        const [requiredPart, optionalPart] = desc.split('Optional columns:');
        expect(optionalPart).toBeDefined();

        const { header, row } = exampleCsv();
        const values = row.match(/("[^"]*"|[^,]+)/g) ?? [];
        expect(values).toHaveLength(header.length);
        expect(header[0]).toBe('Name');
        const exampleName = values[0] ?? '';
        expect(exampleName).not.toBe('');

        // The example itself imports cleanly — the positive companion, so a
        // parser that refused everything could not pass the loop below.
        expect(await uploadAndReadStatus(`${header.join(',')}\n${row}`, exampleName)).toBe(IMPORT.rowOk);

        // Blank each column in turn: the ones whose absence the importer
        // refuses are the ones it REQUIRES. The Name cell carries the
        // iteration number so each read waits for its own upload.
        const requiredByImporter: string[] = [];
        for (let i = 0; i < header.length; i++) {
            const name = i === 0 ? '' : `${exampleName} ${i}`;
            const cells = values.map((v, j) => (j === i ? '' : j === 0 ? name : v));
            const status = await uploadAndReadStatus(`${header.join(',')}\n${cells.join(',')}`, name || '—');
            if (status !== IMPORT.rowOk) requiredByImporter.push(header[i]);
        }
        expect(requiredByImporter).toEqual(expect.arrayContaining(['Name', 'Type']));

        for (const col of requiredByImporter) {
            const word = new RegExp(`\\b${col}\\b`);
            // Named as required, and NOT listed among the optional columns —
            // Type was listed there while every row without it was refused.
            expect({ col, inRequired: word.test(requiredPart) }).toEqual({ col, inRequired: true });
            expect({ col, inOptional: word.test(optionalPart) }).toEqual({ col, inOptional: false });
        }
    });
});

describe('Asset import — the result says what happened', () => {
    it('a refused request reads as a failure, with the server reason', async () => {
        respond(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload' } });
        mountAs('EDITOR');
        const { header, row } = exampleCsv();
        expect(await uploadAndReadStatus(`${header.join(',')}\n${row}`, 'Prod DB')).toBe(IMPORT.rowOk);

        await act(async () => {
            fireEvent.click(document.getElementById('import-btn') as HTMLElement);
        });

        const heading = await waitFor(() => {
            const el = document.getElementById('asset-import-result');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        expect(heading.textContent).toBe(IMPORT.importFailed);
        expect(heading.className).toContain('text-content-error');
        expect(heading.className).not.toContain('text-content-success');
        // Never the success sentence, which read "0 of 1 assets created".
        expect(screen.queryByText(IMPORT.importComplete.replace('{created}', '0').replace('{total}', '1'))).toBeNull();
        // The server's own reason is shown, not a generic status code.
        expect(screen.getByText('Invalid request payload')).toBeInTheDocument();
    });

    it('an accepted request still reads as complete (positive companion)', async () => {
        mountAs('EDITOR');
        const { header, row } = exampleCsv();
        expect(await uploadAndReadStatus(`${header.join(',')}\n${row}`, 'Prod DB')).toBe(IMPORT.rowOk);

        await act(async () => {
            fireEvent.click(document.getElementById('import-btn') as HTMLElement);
        });

        const heading = await waitFor(() => {
            const el = document.getElementById('asset-import-result');
            expect(el).not.toBeNull();
            return el as HTMLElement;
        });
        expect(heading.textContent).toBe(
            IMPORT.importComplete.replace('{created}', '1').replace('{total}', '1'),
        );
        expect(heading.className).toContain('text-content-success');
    });
});

describe('Asset import — who may reach the form', () => {
    it('a custom role without assets.create gets the forbidden card, as the route would refuse it', () => {
        // Built on EDITOR, so the coarse write tier is true — the case the
        // tier-only gate let through.
        mountAs('EDITOR', (p) => ({ ...p, assets: { ...p.assets, create: false } }));
        expect(screen.getByText(IMPORT.forbidden)).toBeInTheDocument();
        expect(document.getElementById('choose-csv')).toBeNull();
    });

    it('an EDITOR (holds assets.create) gets the form', () => {
        mountAs('EDITOR');
        expect(document.getElementById('choose-csv')).not.toBeNull();
        expect(screen.queryByText(IMPORT.forbidden)).toBeNull();
    });

    it('a READER gets the forbidden card', () => {
        mountAs('READER');
        expect(screen.getByText(IMPORT.forbidden)).toBeInTheDocument();
    });
});

describe('Asset import — what the result names (#4800)', () => {
    it("a skipped row is named by its line in the file, not its place in the request", async () => {
        mountAs('EDITOR');
        // Row 1 is invalid (no type), so the server receives only row 2, and
        // numbers it 1.
        respond(200, {
            created: 0,
            skipped: 1,
            errors: [],
            skippedRows: [{ row: 1, name: 'Prod DB', reason: 'existing' }],
        });
        const csv = 'Name,Type\nBroken row,\nProd DB,DATA_STORE';
        expect(await uploadAndReadStatus(csv, 'Broken row')).not.toBe(IMPORT.rowOk);

        await act(async () => {
            fireEvent.click(document.getElementById('import-btn') as HTMLElement);
        });
        const result = await waitFor(() => {
            const el = document.getElementById('asset-import-result');
            expect(el).not.toBeNull();
            return el!.parentElement as HTMLElement;
        });
        const skipLine = IMPORT.rowLabel.replace('{num}', '2').replace('{name}', 'Prod DB');
        expect(result).toHaveTextContent(skipLine);
        expect(result).not.toHaveTextContent(IMPORT.rowLabel.replace('{num}', '1').replace('{name}', 'Prod DB'));
    });

    it('the preview names the type in words', async () => {
        mountAs('EDITOR');
        await uploadAndReadStatus('Name,Type\nProd DB,DATA_STORE', 'Prod DB');
        const preview = document.getElementById('asset-import-preview') as HTMLElement;
        expect(preview).toHaveTextContent(en.assets.assetTypes.DATA_STORE);
        expect(preview).not.toHaveTextContent('DATA_STORE');
    });
});
