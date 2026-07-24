'use client';
import { useState, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { getAssetCriticality } from '@/lib/asset-criticality';
import { cn } from '@/lib/cn';

const ASSET_TYPES = [
    'INFORMATION', 'APPLICATION', 'SYSTEM', 'SERVICE', 'DATA_STORE',
    'INFRASTRUCTURE', 'VENDOR', 'PROCESS', 'PEOPLE_PROCESS', 'OTHER',
];
const ASSET_STATUSES = ['ACTIVE', 'RETIRED'];

type ParsedRow = {
    name: string;
    type?: string;
    status?: string;
    owner?: string;
    classification?: string;
    location?: string;
    confidentiality?: number;
    integrity?: number;
    availability?: number;
    externalRef?: string;
    dependencies?: string;
    businessProcesses?: string;
    retention?: string;
    retentionUntil?: string;
    dataResidency?: string;
    cpe?: string;
    vendor?: string;
    product?: string;
    version?: string;
    /** Per-row validation error (blocks import for this row); undefined = OK. */
    error?: string;
};

export default function AssetImportPage() {
    const apiUrl = useTenantApiUrl();
    const href = useTenantHref();
    const tenant = useTenantContext();
    const canWrite = tenant.permissions.canWrite;
    const t = useTranslations('assets');

    const fileRef = useRef<HTMLInputElement>(null);
    const [rows, setRows] = useState<ParsedRow[]>([]);
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<{
        created: number;
        skipped: number;
        errors: string[];
        skippedRows: { row: number; name: string; reason: string }[];
    } | null>(null);

    // Single-line CSV field split — handles quoted fields containing commas
    // and escaped "" quotes (the naive `line.split(',')` broke on both).
    // Cross-line quoted newlines are out of scope: each physical line is parsed
    // independently, matching the line-oriented split below.
    const parseCsvLine = (line: string): string[] => {
        const out: string[] = [];
        let cur = '';
        let inQuotes = false;
        for (let k = 0; k < line.length; k++) {
            const ch = line[k];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[k + 1] === '"') { cur += '"'; k++; } // escaped quote
                    else inQuotes = false;
                } else cur += ch;
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                out.push(cur); cur = '';
            } else {
                cur += ch;
            }
        }
        out.push(cur);
        return out.map((c) => c.trim());
    };

    const parseCSV = (text: string): ParsedRow[] => {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) return [];
        const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
        const nameIdx = headers.indexOf('name');
        if (nameIdx < 0) return [];

        const col = (cols: string[], header: string): string | undefined => {
            const idx = headers.indexOf(header);
            if (idx < 0) return undefined;
            const v = cols[idx];
            return v ? v : undefined;
        };
        const cia = (raw: string | undefined): { value?: number; invalid?: boolean } => {
            if (raw === undefined) return {};
            const n = parseInt(raw, 10);
            if (Number.isNaN(n) || n < 1 || n > 5) return { invalid: true };
            return { value: n };
        };

        return lines.slice(1).map((line): ParsedRow => {
            const cols = parseCsvLine(line);
            const name = cols[nameIdx] ?? '';
            const rawType = col(cols, 'type');
            const rawStatus = col(cols, 'status');
            const c = cia(col(cols, 'confidentiality'));
            const i = cia(col(cols, 'integrity'));
            const a = cia(col(cols, 'availability'));

            const errors: string[] = [];
            if (!name) errors.push(t('import.errNameRequired'));
            const type = rawType ? rawType.toUpperCase() : undefined;
            if (!type) errors.push(t('import.errTypeRequired'));
            else if (!ASSET_TYPES.includes(type)) errors.push(t('import.errType', { value: rawType! }));
            const status = rawStatus ? rawStatus.toUpperCase() : undefined;
            if (status && !ASSET_STATUSES.includes(status)) errors.push(t('import.errStatus', { value: rawStatus! }));
            // Criticality is NOT imported — the server derives it from the CIA
            // triad (the single source of truth). The preview column below shows
            // that derived value; there is no separate CSV criticality override.
            if (c.invalid || i.invalid || a.invalid) errors.push(t('import.errCia'));

            return {
                name,
                type,
                status,
                owner: col(cols, 'owner'),
                classification: col(cols, 'classification'),
                location: col(cols, 'location'),
                confidentiality: c.value,
                integrity: i.value,
                availability: a.value,
                externalRef: col(cols, 'externalref'),
                dependencies: col(cols, 'dependencies'),
                businessProcesses: col(cols, 'businessprocesses'),
                retention: col(cols, 'retention'),
                retentionUntil: col(cols, 'retentionuntil'),
                dataResidency: col(cols, 'dataresidency'),
                cpe: col(cols, 'cpe'),
                vendor: col(cols, 'vendor'),
                product: col(cols, 'product'),
                version: col(cols, 'version'),
                error: errors.length ? errors.join('; ') : undefined,
            };
        }).filter((r) => r.name || r.error);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setResult(null);
        const reader = new FileReader();
        reader.onload = (ev) => {
            const text = ev.target?.result as string;
            setRows(parseCSV(text));
        };
        reader.readAsText(file);
    };

    const validRows = rows.filter((r) => !r.error);

    const doImport = async () => {
        setImporting(true);
        // Client-side parse errors (invalid rows never reach the server).
        const errors: string[] = rows
            .map((row, i) => ({ row, i }))
            .filter(({ row }) => row.error)
            .map(({ row, i }) => `${t('import.rowLabel', { num: i + 1, name: row.name || '—' })}: ${row.error}`);

        // One bulk request instead of N sequential POSTs. The server dedupes by
        // name (in-batch + against existing assets) and resolves free-text
        // owners to members; criticality is derived from CIA server-side.
        const assets = validRows.map((row) => {
            const a: Record<string, unknown> = { name: row.name, type: row.type };
            if (row.status) a.status = row.status;
            if (row.owner) a.owner = row.owner;
            if (row.classification) a.classification = row.classification;
            if (row.location) a.location = row.location;
            if (row.confidentiality !== undefined) a.confidentiality = row.confidentiality;
            if (row.integrity !== undefined) a.integrity = row.integrity;
            if (row.availability !== undefined) a.availability = row.availability;
            if (row.externalRef) a.externalRef = row.externalRef;
            if (row.dependencies) a.dependencies = row.dependencies;
            if (row.businessProcesses) a.businessProcesses = row.businessProcesses;
            if (row.retention) a.retention = row.retention;
            if (row.retentionUntil) a.retentionUntil = row.retentionUntil;
            if (row.dataResidency) a.dataResidency = row.dataResidency;
            if (row.cpe) a.cpe = row.cpe;
            if (row.vendor) a.vendor = row.vendor;
            if (row.product) a.product = row.product;
            if (row.version) a.version = row.version;
            return a;
        });

        let created = 0;
        let skipped = 0;
        // Per-row skipped-duplicate reasons surfaced from the server so the
        // user sees WHICH rows were dropped and why, not just a bare count.
        const skippedRows: { row: number; name: string; reason: string }[] = [];
        if (assets.length > 0) {
            try {
                const res = await fetch(apiUrl('/assets/bulk/import'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assets }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error?.message || data.message || `Status ${res.status}`);
                }
                const data = await res.json();
                created = data.created ?? 0;
                skipped = data.skipped ?? 0;
                for (const e of (data.errors ?? []) as { row: number; name: string; message: string }[]) {
                    errors.push(`${t('import.rowLabel', { num: e.row, name: e.name || '—' })}: ${e.message}`);
                }
                for (const s of (data.skippedRows ?? []) as { row: number; name: string; reason: string }[]) {
                    skippedRows.push(s);
                }
            } catch (err) {
                errors.push(err instanceof Error ? err.message : String(err));
            }
        }
        setResult({ created, skipped, errors, skippedRows });
        setImporting(false);
    };

    if (!canWrite) {
        return (
            <div className="space-y-section animate-fadeIn">
                <Card className="text-center">
                    <p className="text-content-muted">{t('import.forbidden')}</p>
                    <Link href={href('/assets')} className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>
                        {t('import.backToAssets')}
                    </Link>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn max-w-4xl">
            <BackAffordance />
            <div>
                <Heading level={1}>{t('import.title')}</Heading>
                <p className="text-content-muted text-sm">{tenant.tenantName}</p>
            </div>

            {/* Format info */}
            <div className={cn(cardVariants({ density: 'compact' }), 'border-border-emphasis/50')}>
                <Heading level={3} className="mb-2">{t('import.csvFormat')}</Heading>
                <p className="text-xs text-content-muted">{t('import.csvDesc')}</p>
                <pre className="mt-2 text-xs text-content-subtle bg-bg-page/50 p-2 rounded overflow-x-auto">
                    {/* Template-literal so the quoted-CSV example's `"` stay plain
                        text (react/no-unescaped-entities) — and it doubles as a
                        demo of the quoted-field parsing the importer now supports. */}
                    {`Name,Type,Status,Owner,Classification,Location,Confidentiality,Integrity,Availability,ExternalRef,Dependencies,BusinessProcesses,Retention,DataResidency,CPE,Vendor,Product,Version
Prod DB,DATA_STORE,ACTIVE,DBA,Confidential,eu-west-1,5,5,4,CMDB-1042,"Auth service, Billing",Checkout,7 years,EU,cpe:2.3:a:postgresql:postgresql:16,postgresql,postgresql,16`}
                </pre>
            </div>

            {/* File picker */}
            {!result && (
                <>
                    <input type="file" accept=".csv" ref={fileRef} onChange={handleFileChange} className="hidden" id="csv-file-input" />
                    <Button variant="secondary" className="w-full py-4 text-center" onClick={() => fileRef.current?.click()} id="choose-csv">
                        {t('import.chooseFile')}
                    </Button>
                </>
            )}

            {/* Preview */}
            {rows.length > 0 && !result && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    <div className="p-3 border-b border-border-subtle flex justify-between items-center">
                        <span className="text-sm font-medium">{t('import.assetsToImport', { count: validRows.length })}</span>
                        <Button variant="primary" size="sm" onClick={doImport} disabled={importing || validRows.length === 0} id="import-btn">
                            {importing ? t('import.importing', { count: validRows.length }) : t('import.confirmImport', { count: validRows.length })}
                        </Button>
                    </div>
                    {(() => {
                        const previewCols = createColumns<ParsedRow & { _idx: number }>([
                            { id: 'num', header: '#', accessorKey: '_idx', cell: ({ getValue }) => <span className="text-xs text-content-subtle">{getValue()}</span> },
                            { accessorKey: 'name', header: t('import.colName'), cell: ({ getValue }) => <span className="text-sm">{getValue() || '—'}</span> },
                            { id: 'type', header: t('import.colType'), accessorKey: 'type', cell: ({ getValue }) => <span className="text-xs text-content-muted">{getValue() || '—'}</span> },
                            {
                                id: 'criticality',
                                header: t('import.colCriticality'),
                                accessorFn: (r) => getAssetCriticality(r.confidentiality ?? 3, r.integrity ?? 3, r.availability ?? 3).label,
                                cell: ({ getValue }) => <span className="text-xs">{getValue()}</span>,
                            },
                            { id: 'owner', header: t('import.colOwner'), accessorKey: 'owner', cell: ({ getValue }) => <span className="text-xs text-content-muted">{getValue() || '—'}</span> },
                            {
                                id: 'row-status',
                                header: t('import.colStatus'),
                                accessorFn: (r) => r.error ?? '',
                                cell: ({ row }) => row.original.error
                                    ? <StatusBadge variant="error" size="sm">{row.original.error}</StatusBadge>
                                    : <StatusBadge variant="success" size="sm">{t('import.rowOk')}</StatusBadge>,
                            },
                        ]);
                        const previewData = rows.slice(0, 20).map((r, i) => ({ ...r, _idx: i + 1 }));
                        return (
                            <>
                                <DataTable
                                    data={previewData}
                                    columns={previewCols}
                                    getRowId={(r) => String(r._idx)}
                                    emptyState={t('import.previewEmpty')}
                                    resourceName={(p) => (p ? t('import.rowsWord') : t('import.rowWord'))}
                                    data-testid="asset-import-preview"
                                />
                                {rows.length > 20 && (
                                    <p className="text-center text-xs text-content-subtle py-2">{t('import.moreRows', { count: rows.length - 20 })}</p>
                                )}
                            </>
                        );
                    })()}
                </div>
            )}

            {/* No valid rows warning. Reading fileRef.current during render
                is intentional — the file-input ref is the source of truth for
                "has the user picked a file?" (see the risks importer note). */}
            {/* eslint-disable-next-line react-hooks/refs */}
            {rows.length === 0 && fileRef.current?.files?.length ? (
                <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-warning')}>{t('import.invalidCsv')}</div>
            ) : null}

            {/* Result */}
            {result && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <p className="text-lg font-semibold text-content-success">
                        {t('import.importComplete', { created: result.created, total: rows.length })}
                    </p>
                    {result.skipped > 0 && (
                        <div className="space-y-1">
                            <p className="text-sm text-content-muted">
                                {t('import.skippedDuplicates', { count: result.skipped })}
                            </p>
                            {result.skippedRows.map((s, i) => (
                                <p key={i} className="text-xs text-content-subtle">
                                    {t('import.rowLabel', { num: s.row, name: s.name || '—' })}:{' '}
                                    {t(`import.skipReason.${s.reason}` as Parameters<typeof t>[0])}
                                </p>
                            ))}
                        </div>
                    )}
                    {result.errors.length > 0 && (
                        <div className="space-y-1">
                            <p className="text-sm text-content-error font-medium">{t('import.errors')}:</p>
                            {result.errors.map((e, i) => (
                                <p key={i} className="text-xs text-content-error">{e}</p>
                            ))}
                        </div>
                    )}
                    <div className="flex gap-compact">
                        <Link href={href('/assets')} className={buttonVariants({ variant: 'primary' })}>
                            {t('import.viewRegister')}
                        </Link>
                        <Button variant="secondary" onClick={() => { setResult(null); setRows([]); if (fileRef.current) fileRef.current.value = ''; }}>
                            {t('import.importMore')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
