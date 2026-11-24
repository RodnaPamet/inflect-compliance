'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { INCIDENT_AUTHORITY_ANCHOR, MAX_INCIDENT_AUTHORITY_LENGTH } from '@/lib/incidents/authority';

/**
 * THE INCIDENT NOTIFICATION AUTHORITY — the NIS2 Article 23 CSIRT or competent
 * authority every incident names as the one to notify
 * (`TenantSecuritySettings.incidentAuthority`).
 *
 * Free text, written through the settings route's patch: an empty field saves
 * as null, which is "no authority named", and the incident page says so.
 *
 * The card carries the page anchor the incident page links to, and renders its
 * frame while it loads so the anchor exists from the first paint. Once loaded
 * it scrolls itself into view when the URL names it, because the browser's own
 * jump to the fragment happens before a client-loaded field exists.
 * `scroll-mt-24` (96px) lands the heading below the sticky top bar
 * (`NAV_BAR_HEIGHT`, at least 64px) rather than under it.
 */
export function IncidentAuthorityCard() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();

    /** What is STORED: null is "none named". `undefined` = not loaded. */
    const [stored, setStored] = useState<string | null | undefined>(undefined);
    const [unavailable, setUnavailable] = useState(false);
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<'saved' | 'cleared' | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const scrolled = useRef(false);

    const adopt = useCallback((next: string | null) => {
        setStored(next);
        setValue(next ?? '');
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/admin/security-settings'));
            if (!res.ok) { setUnavailable(true); return; }
            const body = (await res.json()) as { incidentAuthority?: string | null };
            adopt(body.incidentAuthority ?? null);
        } catch {
            setUnavailable(true);
        }
    }, [apiUrl, adopt]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    // Land on the field when the incident page's link named it.
    useEffect(() => {
        if (stored === undefined || scrolled.current) return;
        if (typeof window === 'undefined' || window.location.hash !== `#${INCIDENT_AUTHORITY_ANCHOR}`) return;
        scrolled.current = true;
        cardRef.current?.scrollIntoView({ block: 'start' });
    }, [stored]);

    async function save() {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const trimmed = value.trim();
            const res = await fetch(apiUrl('/admin/security-settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ incidentAuthority: trimmed === '' ? null : trimmed }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(apiErrorMessage(body, t('security.incidentAuthority.saveFailed')));
                return;
            }
            const next = (body as { incidentAuthority?: string | null }).incidentAuthority ?? null;
            adopt(next);
            setNotice(next === null ? 'cleared' : 'saved');
        } catch {
            setError(t('security.incidentAuthority.saveFailed'));
        } finally {
            setBusy(false);
        }
    }

    const dirty = stored !== undefined && value.trim() !== (stored ?? '');

    return (
        <Card
            ref={cardRef}
            id={INCIDENT_AUTHORITY_ANCHOR}
            className="scroll-mt-24"
            data-testid="incident-authority-card"
        >
            <div className="space-y-default">
                <div>
                    <Heading level={2} className="mb-1">{t('security.incidentAuthority.title')}</Heading>
                    <p className="text-sm text-content-muted">{t('security.incidentAuthority.description')}</p>
                </div>

                {unavailable ? (
                    <p className="text-sm text-content-muted">{t('security.incidentAuthority.unavailable')}</p>
                ) : stored === undefined ? null : (
                    <>
                        <p className="text-sm text-content-default break-words" data-testid="incident-authority-state">
                            {stored === null
                                ? t('security.incidentAuthority.stateNone')
                                : t('security.incidentAuthority.stateSet', { authority: stored })}
                        </p>

                        <FormField
                            label={t('security.incidentAuthority.label')}
                            description={t('security.incidentAuthority.hint', { max: MAX_INCIDENT_AUTHORITY_LENGTH })}
                        >
                            <Input
                                id="incident-authority-input"
                                value={value}
                                maxLength={MAX_INCIDENT_AUTHORITY_LENGTH}
                                placeholder={t('security.incidentAuthority.placeholder')}
                                onChange={(e) => { setValue(e.target.value); setNotice(null); }}
                            />
                        </FormField>

                        {error && <InlineNotice variant="error" icon={null}>{error}</InlineNotice>}
                        {notice && !error && (
                            <InlineNotice variant="success" icon={null}>
                                {t(notice === 'saved' ? 'security.incidentAuthority.saved' : 'security.incidentAuthority.cleared')}
                            </InlineNotice>
                        )}

                        <div className="flex justify-end">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={save}
                                disabled={!dirty || busy}
                                loading={busy}
                                id="incident-authority-save"
                                text={t('security.incidentAuthority.save')}
                            />
                        </div>
                    </>
                )}
            </div>
        </Card>
    );
}
