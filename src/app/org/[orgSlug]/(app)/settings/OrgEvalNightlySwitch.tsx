'use client';

/**
 * One evaluation nightly's switch, on the "Evaluations" card (owner decision
 * 2026-11-27). Rendered only for a viewer the server says may switch (an
 * ORG_OWNER of an operator organization); everybody else gets the card's
 * read-only text and no control at all.
 *
 * Each switch saves on its own, sending its one nightly: `PUT
 * …/eval-nightlies { nightly, enabled }`. On success it takes the server's
 * answer for its own state and refreshes the page, so the card's badge and
 * "since" line re-render from the stored row. The nightly's spending cap sits
 * beside the switch, because turning it on is turning that spend on.
 *
 * The card stays a server component: this is the only JavaScript it ships.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiErrorMessage } from '@/lib/api-error';
import { useOrgApiUrl } from '@/lib/org-context-provider';
import type { EvalNightlyKey } from '@/lib/evals/evaluation-nightlies';

export function OrgEvalNightlySwitch({
    nightly,
    initialEnabled,
    budget,
}: {
    nightly: EvalNightlyKey;
    initialEnabled: boolean;
    /** The nightly's spending cap, already worded by the card. */
    budget: string;
}) {
    const t = useTranslations('org.settings.evaluations');
    const apiUrl = useOrgApiUrl();
    const router = useRouter();
    const [enabled, setEnabled] = useState(initialEnabled);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const id = `org-evals-${nightly}-toggle`;

    async function flip(next: boolean) {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(apiUrl('/eval-nightlies'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nightly, enabled: next }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(apiErrorMessage(body, t('saveFailed')));
                return;
            }
            const saved = (body as { switches?: { nightlies?: Record<string, { enabled?: boolean }> } }).switches
                ?.nightlies?.[nightly]?.enabled;
            setEnabled(saved === true);
            router.refresh();
        } catch {
            setError(t('saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-tight">
            <div className="flex flex-wrap items-center gap-compact">
                <Switch
                    id={id}
                    checked={enabled}
                    disabled={busy}
                    onCheckedChange={(on) => void flip(on)}
                    aria-describedby={`${id}-budget`}
                    data-testid={id}
                />
                <Label htmlFor={id} className="min-w-0 text-content-default">
                    {t(enabled ? 'toggle.on' : 'toggle.off')}
                </Label>
            </div>
            <p id={`${id}-budget`} className="text-xs text-content-muted">
                {t('toggle.spend', { budget })}
            </p>
            {error && (
                <InlineNotice variant="error" icon={null}>
                    <span data-testid={`${id}-error`}>{error}</span>
                </InlineNotice>
            )}
        </div>
    );
}
