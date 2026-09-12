'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useToast } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/**
 * File the pack into the evidence library.
 *
 * ── IT DOES NOT DOWNLOAD ANYTHING, AND THE LABEL SAYS SO ────────────────────
 *
 * "Export" in most products means a file lands in the browser's downloads
 * folder. Here it means a retained record appears in the evidence library, owned
 * by the person who clicked and kept for seven years. Those are different enough
 * that a label reading only "Export" would mislead — somebody would click it,
 * see no download, and click it again, filing two packs. The label names the
 * destination, and the confirmation afterwards says where the record went.
 *
 * ── NO UNDO RAIL, DELIBERATELY ─────────────────────────────────────────────
 *
 * Epic 67's deferred-commit toast is for DESTRUCTIVE actions, where the 5s
 * window is the only thing standing between a misclick and a lost row. Filing a
 * document destroys nothing; the worst case is a duplicate the operator can
 * delete from the library. Wiring an undo rail here would dilute the signal that
 * a delayed toast means "something is about to be destroyed".
 */
export function ExportPackButton() {
    const t = useTranslations('agents');
    const toast = useToast();
    const apiUrl = useTenantApiUrl();
    const [busy, setBusy] = useState(false);
    const [filed, setFiled] = useState<{ title: string; enforcing: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const onExport = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/admin/agents/reports/export'), { method: 'POST' });
            if (!res.ok) {
                // `.json()` on an error body can itself throw (a 502 HTML page),
                // so it is caught into `null` and the helper falls back.
                const body = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(body, t('reports.exportFailed')));
            }
            const body = (await res.json()) as { title: string; enforcing: boolean };
            setFiled({ title: body.title, enforcing: body.enforcing });
            toast.success(t('reports.exportFiledToast'));
        } catch (e) {
            // Surfaced INLINE as well as in the toast. The likely failure is a
            // missing `evidence.edit` permission, and a toast that has already
            // faded leaves the operator clicking a button that will never work
            // without telling them why.
            const message = e instanceof Error ? e.message : t('reports.exportFailed');
            setError(message);
            toast.error(message);
        } finally {
            setBusy(false);
        }
    }, [apiUrl, t, toast]);

    return (
        <div className="flex flex-col gap-tight" data-testid="reports-export">
            <Button
                variant="secondary"
                onClick={onExport}
                disabled={busy}
                data-testid="reports-export-button"
            >
                {busy ? t('reports.exportBusy') : t('reports.exportAction')}
            </Button>

            {error && (
                <InlineNotice variant="error" data-testid="reports-export-error">
                    {error}
                </InlineNotice>
            )}

            {filed && (
                <InlineNotice variant="success" data-testid="reports-export-filed">
                    {t('reports.exportFiledBody', { title: filed.title })}
                    {/* The caveat travels INTO the filed document, and it is
                        repeated here so the person filing it knows what they
                        just put their name to — not only the person who reads
                        it later. */}
                    {!filed.enforcing ? ` ${t('reports.exportFiledNotEnforcing')}` : ''}
                </InlineNotice>
            )}
        </div>
    );
}
