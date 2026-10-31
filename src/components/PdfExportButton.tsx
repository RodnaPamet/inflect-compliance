'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';

export type PdfReportType = 'AUDIT_READINESS' | 'RISK_REGISTER' | 'GAP_ANALYSIS';

interface PdfExportButtonProps {
    tenantSlug: string;
    reportType: PdfReportType;
    /** Button label */
    label?: string;
    /** Allow saving as evidence file record */
    allowSave?: boolean;
    /** Additional CSS classes */
    className?: string;
    /**
     * PR-H — the selected framework (from the Reports selector). Forwarded to
     * the generator so the artifact names the real framework, not the resolved
     * default. Omit for framework-agnostic reports (e.g. Risk Register).
     */
    framework?: string;
}

/**
 * Pill-styled PDF export button.
 * - Click → calls server-side PDF generation → triggers browser download.
 * - Shift+click (or "Save" variant) → saves to FileRecord too.
 *
 * Outcomes are toasts, like every other confirmation in the product, and a
 * refusal shows the server's reason (#4641). The route refuses for named
 * reasons — no `reports.export`, a plan without PDF exports — and a browser
 * `alert()` saying only "failed" both blocked the page and hid them.
 */
export function PdfExportButton({
    tenantSlug,
    reportType,
    label,
    allowSave = false,
    className = '',
    framework,
}: PdfExportButtonProps) {
    const t = useTranslations('panels.pdf');
    const toast = useToast();
    const labelText = label ?? t('export');
    const [generating, setGenerating] = useState(false);
    const [saving, setSaving] = useState(false);

    const handleExport = async (saveToFile = false) => {
        const setLoading = saveToFile ? setSaving : setGenerating;
        setLoading(true);

        try {
            const res = await fetch(`/api/t/${tenantSlug}/reports/pdf/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: reportType,
                    saveToFileRecord: saveToFile,
                    ...(framework ? { framework } : {}),
                }),
            });

            if (!res.ok) {
                const body: unknown = await res.json().catch(() => null);
                toast.error(apiErrorMessage(body, t('failed')));
                return;
            }

            if (saveToFile) {
                // FileRecord saved — show confirmation
                const data = await res.json();
                toast.success(t('saved', { fileName: data.fileName, size: (data.sizeBytes / 1024).toFixed(1) }));
            } else {
                // Stream → download
                const blob = await res.blob();
                const disposition = res.headers.get('Content-Disposition');
                const fileNameMatch = disposition?.match(/filename="?([^"]+)"?/);
                const fileName = fileNameMatch?.[1] || `${reportType}_${new Date().toISOString().slice(0, 10)}.pdf`;

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        } catch {
            // A network failure, or a response that was not the PDF it claimed.
            toast.error(t('failed'));
        } finally {
            setLoading(false);
        }
    };

    const isLoading = generating || saving;

    return (
        <div className="inline-flex gap-1">
            <Button
                variant="secondary"
                className={className}
                onClick={() => handleExport(false)}
                disabled={isLoading}
                id={`export-pdf-${reportType.toLowerCase()}-btn`}
            >
                {generating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                    <Download className="w-3.5 h-3.5" />
                )}
                {generating ? t('generating') : labelText}
            </Button>

            {allowSave && (
                <Tooltip content={t('saveTooltip')}>
                    <Button
                        variant="secondary"
                        onClick={() => handleExport(true)}
                        disabled={isLoading}
                        aria-label={t('saveAria')}
                        id={`save-pdf-${reportType.toLowerCase()}-btn`}
                    >
                        {saving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Save className="w-3.5 h-3.5" />
                        )}
                    </Button>
                </Tooltip>
            )}
        </div>
    );
}
