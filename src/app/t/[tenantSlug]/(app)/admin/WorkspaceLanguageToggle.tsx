'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ToggleGroup } from '@/components/ui/toggle-group';
import { InfoTooltip } from '@/components/ui/tooltip';
import { useToast } from '@inflect/ui/components/ui/hooks/use-toast';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import {
    LOCALE_LABELS,
    LOCALE_SHORT_LABELS,
    SUPPORTED_LOCALES,
    resolveLocale,
    type Locale,
} from '@/lib/locale-constants';

/**
 * WORKSPACE LANGUAGE — the language of text the product writes into this
 * workspace's records on its behalf (owner decision 2026-11-24). It sits in
 * the Admin hub's header, under the theme switch, as an EN | БГ toggle (owner
 * decision 2026-11-25, #5965); it was a card at the foot of the hub.
 *
 * It is NOT anyone's interface language, which stays each person's own, per
 * browser — the help icon beside the label says so. That is also why this is
 * not `LocaleSwitcher`: that control writes the viewer's own UI-language
 * cookie; this one writes `Tenant.defaultLocale` through
 * `PUT /admin/workspace-language`, which audits the change and does nothing
 * for the value already stored.
 *
 * A choice saves at once. The new value shows while the request runs, the
 * other option is disabled until it answers, and a refusal puts the stored
 * value back and says so. The options show the short code, as the language
 * switcher does, with the endonym (in its own `lang`) as each radio's
 * accessible name.
 *
 * Rendered only for a holder of `admin.manage`, the key its PUT takes; the
 * server page reads the stored value and passes it in.
 */
export function WorkspaceLanguageToggle({ initialLocale }: { initialLocale: Locale }) {
    const t = useTranslations('workspaceLanguage');
    const tui = useTranslations('common.ui');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    // `stored` is what the server last confirmed; `shown` is what the toggle
    // shows, which runs ahead of it while a save is in flight.
    const stored = useRef<Locale>(initialLocale);
    const [shown, setShown] = useState<Locale>(initialLocale);
    const [busy, setBusy] = useState(false);

    async function choose(value: string) {
        const next = resolveLocale(value);
        if (busy || next === shown) return;
        setShown(next);
        setBusy(true);
        try {
            const res = await fetch(apiUrl('/admin/workspace-language'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultLocale: next }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setShown(stored.current);
                toast.error(apiErrorMessage(body, t('saveFailed')));
                return;
            }
            const confirmed = resolveLocale((body as { defaultLocale?: unknown }).defaultLocale);
            stored.current = confirmed;
            setShown(confirmed);
            toast.success(t('saved'));
        } catch {
            setShown(stored.current);
            toast.error(t('saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    const options = SUPPORTED_LOCALES.map((locale) => ({
        value: locale,
        id: `workspace-language-${locale}`,
        // While a save runs, only the option being saved stays enabled, so
        // focus (on it) is kept and the other cannot race it.
        disabled: busy && locale !== shown,
        label: (
            <>
                <span aria-hidden="true">{LOCALE_SHORT_LABELS[locale]}</span>
                <span className="sr-only" lang={locale}>{LOCALE_LABELS[locale]}</span>
            </>
        ),
    }));

    return (
        // Label over toggle, as the owner's sketch has it: the label line
        // spans the box under the theme row, and the toggle sits beneath it
        // at the end. `aria-busy` while a save runs.
        <div
            id="workspace-language-toggle"
            className="flex flex-col gap-tight"
            aria-busy={busy || undefined}
        >
            <div className="flex items-center gap-tight">
                <span className="text-sm text-content-muted">{t('title')}</span>
                <InfoTooltip
                    aria-label={tui('moreInfoAbout', { title: t('title') })}
                    iconClassName="h-3.5 w-3.5"
                    content={
                        <div className="space-y-tight">
                            <p>{t('description')}</p>
                            <p>{t('notInterface')}</p>
                        </div>
                    }
                />
            </div>
            <ToggleGroup
                size="sm"
                options={options}
                selected={shown}
                selectAction={(v) => void choose(v)}
                ariaLabel={t('title')}
                className="self-end"
            />
        </div>
    );
}
