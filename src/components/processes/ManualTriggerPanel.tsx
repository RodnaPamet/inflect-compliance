'use client';

/**
 * Manual trigger console (Automation Epic 10).
 *
 * "Test a rule" — pick an enabled rule, optionally dry-run (evaluate the
 * filter against the latest sample payload WITHOUT firing), or fire it for
 * real (manual re-trigger). EDITOR+ only; the API enforces the gate.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { AutomationRuleRow } from '@/app/t/[tenantSlug]/(app)/processes/RulesTab';

export function ManualTriggerPanel() {
    // The whole panel was hardcoded English — heading, both buttons, the
    // placeholder and all five result messages.
    const t = useTranslations('automation.manualTrigger');
    const apiUrl = useTenantApiUrl();
    const { data: rules } = useTenantSWR<AutomationRuleRow[]>(CACHE_KEYS.automation.rules.list());
    const [ruleId, setRuleId] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);

    const options: ComboboxOption[] = useMemo(
        () =>
            (rules ?? [])
                .filter((r) => r.status === 'ENABLED')
                .map((r) => ({ value: r.id, label: r.name })),
        [rules],
    );

    async function dryRun() {
        if (!ruleId) return;
        setBusy(true);
        setResult(null);
        try {
            const res = await fetch(apiUrl(`/automation/rules/${ruleId}/dry-run`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                // Was: parse the body regardless and report a match verdict
                // derived from an error payload. A 403 read as "would skip".
                setResult(t('dryRunFailed'));
                return;
            }
            const json = await res.json();
            setResult(json.matches ? t('dryRunMatches') : t('dryRunNoMatch'));
        } finally {
            setBusy(false);
        }
    }

    async function fire() {
        if (!ruleId) return;
        setBusy(true);
        setResult(null);
        try {
            const res = await fetch(apiUrl(`/automation/rules/${ruleId}/re-trigger`), {
                method: 'POST',
            });
            const body = (await res.json().catch(() => ({}))) as {
                enqueued?: boolean;
                reason?: string;
            };
            // Honest result: a replay is only a success when a dispatch was
            // actually enqueued. Distinguish the no-op outcomes so the panel
            // never reports "Fired" for something that did nothing.
            if (res.ok && body.enqueued) {
                setResult(t('fired'));
            } else if (res.ok && body.reason === 'no_prior_execution') {
                setResult(t('nothingToReplay'));
            } else if (res.ok && body.reason === 'entity_target_not_replayable') {
                setResult(t('notReplayable'));
            } else {
                setResult(t('fireFailed'));
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card>
            <div className="space-y-default">
                <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                    {t('heading')}
                </p>
                <Combobox
                    options={options}
                    selected={ruleId ? options.find((o) => o.value === ruleId) ?? null : null}
                    setSelected={(o) => setRuleId(o?.value ?? '')}
                    placeholder={t('selectRulePlaceholder')}
                    matchTriggerWidth
                />
                <div className="flex gap-compact">
                    <Button variant="secondary" disabled={!ruleId || busy} loading={busy} onClick={dryRun}>
                        {t('dryRun')}
                    </Button>
                    <Button variant="primary" disabled={!ruleId || busy} onClick={fire}>
                        {t('fire')}
                    </Button>
                </div>
                {result && <p className="text-sm text-content-muted">{result}</p>}
            </div>
        </Card>
    );
}
