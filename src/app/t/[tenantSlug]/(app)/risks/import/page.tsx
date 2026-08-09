'use client';
import { useState, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useRiskMatrixConfig } from '@/lib/hooks/use-risk-matrix-config';
import { parseCsvRecords } from '@/lib/csv/parse-csv';
import { cn } from '@/lib/cn';
import { extractMutationError } from '@/lib/mutations';

type ParsedRow = {
    title: string;
    description?: string;
    category?: string;
    likelihood?: number;
    impact?: number;
    owner?: string;
    /** Out-of-scale L/I values that were coerced to the default — kept so
     *  the preview can flag the downgrade per row instead of dropping it
     *  silently. */
    outOfScale?: Array<{ field: 'likelihood' | 'impact'; value: number; max: number }>;
};

export default function RiskImportPage() {
    const apiUrl = useTenantApiUrl();
    const href = useTenantHref();
    const tenant = useTenantContext();
    const canWrite = tenant.permissions.canWrite;
    const t = useTranslations('riskManager');
    // Clamp imported L/I to the tenant's configured scale, not a hardcoded
    // 5 — a 6-level tenant's "6" is valid and must not be silently dropped.
    const { config: matrixConfig } = useRiskMatrixConfig();

    const fileRef = useRef<HTMLInputElement>(null);
    const [rows, setRows] = useState<ParsedRow[]>([]);
    const [importing, setImporting] = useState(false);
    const [result, setResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

    const parseCSV = (text: string): ParsedRow[] => {
        // Robust quoted-CSV parse (handles commas/quotes/newlines inside cells).
        const records = parseCsvRecords(text);
        return records
            .map((rec): ParsedRow | null => {
                const title = rec.title;
                if (!title) return null;
                const row: ParsedRow = { title };
                if (rec.description) row.description = rec.description;
                if (rec.category) row.category = rec.category;
                if (rec.likelihood) {
                    const n = parseInt(rec.likelihood, 10);
                    if (Number.isFinite(n)) {
                        if (n >= 1 && n <= matrixConfig.likelihoodLevels) row.likelihood = n;
                        else (row.outOfScale ??= []).push({ field: 'likelihood', value: n, max: matrixConfig.likelihoodLevels });
                    }
                }
                if (rec.impact) {
                    const n = parseInt(rec.impact, 10);
                    if (Number.isFinite(n)) {
                        if (n >= 1 && n <= matrixConfig.impactLevels) row.impact = n;
                        else (row.outOfScale ??= []).push({ field: 'impact', value: n, max: matrixConfig.impactLevels });
                    }
                }
                if (rec.owner) row.owner = rec.owner;
                return row;
            })
            .filter((r): r is ParsedRow => r !== null);
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

    const doImport = async () => {
        setImporting(true);
        try {
            // One bulk request — the server dedupes by title, resolves the
            // free-text owner to a member, and reports per-row errors.
            const res = await fetch(apiUrl('/risks/bulk/import'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    risks: rows.map((r) => ({
                        title: r.title,
                        description: r.description,
                        category: r.category,
                        likelihood: r.likelihood,
                        impact: r.impact,
                        owner: r.owner,
                    })),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error?.message || data.message || `Status ${res.status}`);
            }
            const data = (await res.json()) as {
                created: number;
                skipped: number;
                errors: { row: number; title: string; message: string }[];
            };
            setResult({
                created: data.created,
                skipped: data.skipped,
                errors: data.errors.map((e) => `Row ${e.row} "${e.title}": ${e.message}`),
            });
        } catch (err) {
            setResult({ created: 0, skipped: 0, errors: [extractMutationError(err)] });
        } finally {
            setImporting(false);
        }
    };

    if (!canWrite) {
        return (
            <div className="space-y-section animate-fadeIn">
                <Card className="text-center">
                    <p className="text-content-muted">{t('noImportPermission')}</p>
                    <Link href={href('/risks')} className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>
                        {t('backToRisks')}
                    </Link>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn max-w-4xl">
            <BackAffordance />
            <div>
                <Heading level={1}>{t('importTitle')}</Heading>
                <p className="text-content-muted text-sm">{tenant.tenantName}</p>
            </div>

            {/* Format info */}
            <div className={cn(cardVariants({ density: 'compact' }), 'border-border-emphasis/50')}>
                <Heading level={3} className="mb-2">{t('csvFormat')}</Heading>
                <p className="text-xs text-content-muted">{t('csvDesc')}</p>
                <pre className="mt-2 text-xs text-content-subtle bg-bg-page/50 p-2 rounded overflow-x-auto">
                    title,description,category,likelihood,impact,owner{'\n'}
                    Unauthorized access,Risk of unauthorized data access,Technical,4,5,CISO
                </pre>
            </div>

            {/* File picker */}
            {!result && (
                <>
                    <input type="file" accept=".csv" ref={fileRef} onChange={handleFileChange} className="hidden" id="csv-file-input" />
                    <Button variant="secondary" className="w-full py-4 text-center" onClick={() => fileRef.current?.click()} id="choose-csv">
                        {t('chooseFile')}
                    </Button>
                </>
            )}

            {/* Preview */}
            {rows.length > 0 && !result && (
                <div className={cn(cardVariants({ density: 'none' }), 'overflow-hidden')}>
                    <div className="p-3 border-b border-border-default/50 flex justify-between items-center">
                        <span className="text-sm font-medium">{t('risksToImport', { count: rows.length })}</span>
                        <Button variant="primary" size="sm" onClick={doImport} disabled={importing} id="import-btn">
                            {importing ? t('importing', { count: rows.length }) : t('confirmImport', { count: rows.length })}
                        </Button>
                    </div>
                    {(() => {
                        const previewCols = createColumns<ParsedRow & { _idx: number }>([
                            { id: 'num', header: '#', accessorKey: '_idx', cell: ({ getValue }) => <span className="text-xs text-content-subtle">{getValue()}</span> },
                            { accessorKey: 'title', header: t('colTitle'), cell: ({ getValue }) => <span className="text-sm">{getValue()}</span> },
                            { id: 'category', header: t('colCategory'), accessorKey: 'category', cell: ({ getValue }) => <span className="text-xs text-content-muted">{getValue() || '—'}</span> },
                            { id: 'lxi', header: t('colLxI'), accessorFn: (r) => `${r.likelihood ?? 3}×${r.impact ?? 3}`, cell: ({ row, getValue }) => {
                                const oos = row.original.outOfScale;
                                return (
                                    <div className="flex flex-col gap-0.5">
                                        <span className="text-xs">{getValue() as string}</span>
                                        {oos?.map((c, i) => (
                                            <span key={i} className="text-[11px] text-content-warning" data-testid="import-out-of-scale">
                                                {t(c.field === 'likelihood' ? 'outOfScaleLikelihood' : 'outOfScaleImpact', { value: c.value, max: c.max })}
                                            </span>
                                        ))}
                                    </div>
                                );
                            } },
                            { id: 'owner', header: t('colOwner'), accessorKey: 'owner', cell: ({ getValue }) => <span className="text-xs text-content-muted">{getValue() || '—'}</span> },
                        ]);
                        const previewData = rows.slice(0, 20).map((r, i) => ({ ...r, _idx: i + 1 }));
                        return (
                            <>
                                <DataTable
                                    data={previewData}
                                    columns={previewCols}
                                    getRowId={(r) => String(r._idx)}
                                    emptyState={t('previewEmpty')}
                                    resourceName={(p) => (p ? t('rowsWord') : t('rowWord'))}
                                    data-testid="risk-import-preview"
                                />
                                {rows.length > 20 && (
                                    <p className="text-center text-xs text-content-subtle py-2">{t('moreRows', { count: rows.length - 20 })}</p>
                                )}
                            </>
                        );
                    })()}
                </div>
            )}

            {/* No valid rows warning. Reading fileRef.current during
                render is intentional: the file-input ref is the source
                of truth for "has the user picked a file?" — moving it
                to state would race the controlled-input onChange and
                potentially flash the warning before/after the parser
                catches up. */}
            {/* eslint-disable-next-line react-hooks/refs */}
            {rows.length === 0 && fileRef.current?.files?.length ? (
                <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-warning')}>{t('noValidRows')}</div>
            ) : null}

            {/* Result */}
            {result && (
                <div className={cn(cardVariants(), 'space-y-default')}>
                    <p className="text-lg font-semibold text-content-success">
                        {t('importComplete', { created: result.created, total: rows.length })}
                    </p>
                    {result.skipped > 0 && (
                        <p className="text-sm text-content-muted">
                            {t('importSkipped', { count: result.skipped })}
                        </p>
                    )}
                    {result.errors.length > 0 && (
                        <div className="space-y-1">
                            <p className="text-sm text-content-error font-medium">{t('errors')}:</p>
                            {result.errors.map((e, i) => (
                                <p key={i} className="text-xs text-content-error">{e}</p>
                            ))}
                        </div>
                    )}
                    <div className="flex gap-compact">
                        <Link href={href('/risks')} className={buttonVariants({ variant: 'primary' })}>
                            {t('viewRegister')}
                        </Link>
                        <Button variant="secondary" onClick={() => { setResult(null); setRows([]); if (fileRef.current) fileRef.current.value = ''; }}>
                            {t('importMore')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
