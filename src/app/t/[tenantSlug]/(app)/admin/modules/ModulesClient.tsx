'use client';

/**
 * Turn optional product modules on and off for this tenant.
 *
 * ═══ WHY THE COPY IS BLUNT ABOUT THE CANVAS ═══
 *
 * The process canvas is off by default and the reason is not caution — the
 * editor behind it is licensed software that may not be put in front of
 * customers without a paid key. An operator turning it on for a customer tenant
 * is doing something with consequences outside this product, and a switch that
 * did not say so would be inviting them to.
 *
 * So the warning is on the control, not in a document. It is the only place the
 * decision is actually made.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { Heading } from '@/components/ui/typography';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ErrorState } from '@/components/ui/error-state';

interface ModuleState {
    enabled: boolean;
}

export function ModulesClient() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const { tenantSlug } = useTenantContext();
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);

    // TENANT-RELATIVE. `useTenantSWR` prefixes `/api/t/<slug>` itself, so an
    // absolute path here would resolve to `/api/t/<slug>/api/t/<slug>/…`.
    // Pinned by `useTenantSWR call sites pass tenant-relative paths`.
    const { data, error, isLoading, mutate } = useTenantSWR<ModuleState>(
        '/admin/process-canvas-module',
    );

    async function toggle(next: boolean) {
        setSaving(true);
        setFailed(false);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/admin/process-canvas-module`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            if (!res.ok) throw new Error(String(res.status));
            await mutate();
        } catch {
            // VISIBLE, not swallowed. A toggle that silently failed would leave
            // an operator believing they had turned a licensed surface on — or
            // off — when they had not.
            setFailed(true);
        } finally {
            setSaving(false);
        }
    }

    if (error) return <ErrorState title={t('modules.loadFailed')} />;

    const enabled = data?.enabled === true;

    return (
        <div className="space-y-section" data-testid="admin-modules">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('nav.modules'), href: tenantHref('/admin/modules') },
                    { label: t('modules.breadcrumb') },
                ]}
            />

            <Heading level={1}>{t('modules.heading')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">{t('modules.intro')}</p>

            <section
                className="space-y-compact rounded-lg border border-border-subtle p-5"
                data-testid="module-process-canvas"
            >
                <div className="flex items-start justify-between gap-default">
                    <div className="space-y-tight">
                        <div className="flex items-center gap-tight">
                            <Heading level={2}>{t('modules.processCanvas.name')}</Heading>
                            <StatusBadge variant={enabled ? 'success' : 'neutral'}>
                                {enabled ? t('modules.on') : t('modules.off')}
                            </StatusBadge>
                        </div>
                        <p className="max-w-3xl text-sm text-content-muted">
                            {t('modules.processCanvas.description')}
                        </p>
                    </div>
                    <Button
                        variant="secondary"
                        onClick={() => toggle(!enabled)}
                        disabled={isLoading || saving}
                        data-testid="toggle-process-canvas"
                    >
                        {enabled ? t('modules.turnOff') : t('modules.turnOn')}
                    </Button>
                </div>

                {/* ALWAYS SHOWN, not only when off. The licence constraint binds
                    at the moment somebody turns it ON, so hiding the warning
                    while it is off would hide it from exactly the reader about
                    to cross the line. */}
                <InlineNotice variant="warning" title={t('modules.processCanvas.licenceHeading')}>
                    {t('modules.processCanvas.licenceBody')}
                </InlineNotice>

                {failed && (
                    <InlineNotice variant="error" title={t('modules.saveFailedHeading')}>
                        {t('modules.saveFailedBody')}
                    </InlineNotice>
                )}
            </section>
        </div>
    );
}
