'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ShadedRow } from '@/components/ui/shaded-row';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { LOCALE_LABELS, SUPPORTED_LOCALES, resolveLocale, type Locale } from '@/lib/locale-constants';

/**
 * WORKSPACE LANGUAGE — the language of text the product writes into this
 * workspace's records on its behalf (owner decision 2026-11-24). Today that is
 * the titles of the tasks a NIS2 gap-assessment dispatch creates.
 *
 * The card says what it does NOT do as plainly as what it does: it changes
 * nobody's interface language, which stays each person's own, per browser.
 * Each language is named in its own language (the endonym, with its `lang`),
 * as the language switcher names them.
 *
 * Shown only to a holder of `admin.manage`, the key its PUT takes; the server
 * page reads the stored value and passes it in.
 */
export function WorkspaceLanguageCard({ initialLocale }: { initialLocale: Locale }) {
    const t = useTranslations('workspaceLanguage');
    const apiUrl = useTenantApiUrl();

    const [stored, setStored] = useState<Locale>(initialLocale);
    const [choice, setChoice] = useState<Locale>(initialLocale);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    async function save() {
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            const res = await fetch(apiUrl('/admin/workspace-language'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultLocale: choice }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(apiErrorMessage(body, t('saveFailed')));
                return;
            }
            const next = resolveLocale((body as { defaultLocale?: unknown }).defaultLocale);
            setStored(next);
            setChoice(next);
            setSaved(true);
        } catch {
            setError(t('saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card data-testid="workspace-language-card">
            <div className="space-y-default">
                <div className="space-y-tight">
                    <Heading level={2}>{t('title')}</Heading>
                    <p className="text-sm text-content-muted">{t('description')}</p>
                    <p className="text-sm text-content-muted" data-testid="workspace-language-not-interface">
                        {t('notInterface')}
                    </p>
                </div>

                <FormField label={t('label')}>
                    <RadioGroup
                        id="workspace-language-choice"
                        value={choice}
                        onValueChange={(v) => {
                            setChoice(resolveLocale(v));
                            setSaved(false);
                        }}
                        aria-label={t('label')}
                        className="flex flex-col gap-tight sm:flex-row"
                    >
                        {SUPPORTED_LOCALES.map((locale) => {
                            const id = `workspace-language-${locale}`;
                            return (
                                <ShadedRow
                                    as="label"
                                    key={locale}
                                    htmlFor={id}
                                    interactive
                                    selected={choice === locale}
                                    className="flex min-h-11 items-center gap-compact sm:flex-1"
                                >
                                    <RadioGroupItem id={id} value={locale} size="sm" data-testid={id} />
                                    <span lang={locale} className="text-sm font-medium text-content-emphasis">
                                        {LOCALE_LABELS[locale]}
                                    </span>
                                </ShadedRow>
                            );
                        })}
                    </RadioGroup>
                </FormField>

                {error && <InlineNotice variant="error" icon={null}>{error}</InlineNotice>}
                {saved && !error && (
                    <InlineNotice variant="success" icon={null}>{t('saved')}</InlineNotice>
                )}

                <div className="flex justify-end">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={save}
                        disabled={choice === stored || busy}
                        loading={busy}
                        className="max-sm:w-full"
                        data-testid="workspace-language-save"
                        text={t('save')}
                    />
                </div>
            </div>
        </Card>
    );
}
