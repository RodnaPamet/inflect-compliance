'use client';

/**
 * The sandbox runtime's declared configuration — SEVEN rows, none of them a
 * live switch today (#3995).
 *
 * ═══ THE ONE THING THIS SCREEN MUST NOT DO ═══
 *
 * Present a declaration as an observation. Its sibling `admin/ai-features`
 * must not show a switch over a feature that cannot run; here the hazard is
 * worse, because the rows describe where audit data can LEAVE. An operator who
 * reads "OCSF export: on" and concludes a gateway confirmed it has been told
 * something no gateway was asked — a v0.1.5 gateway exposes no configuration
 * read API at all.
 *
 * Every row therefore renders a kind from `sandbox-runtime-display`, and the
 * only kind that means "verified" is one no input can currently produce.
 *
 * ═══ WHY THE FOURTH CHANNEL LOOKS BROKEN AND IS NOT ═══
 *
 * `ocsf-over-otlp` has no Helm chart key, so its chart cell reads "no chart
 * key" rather than empty. That is the finding, not a gap in this page: the
 * channel is configurable ONLY by environment variable, so a reader auditing
 * the chart would conclude the channel does not exist. Rendering the absence as
 * blank would reproduce exactly that mistake on this page.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { useTenantHref } from '@/lib/tenant-context-provider';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import {
    ENFORCEMENT_SETTINGS,
    REPORTING_CHANNELS,
    type SandboxRuntimeDeclaration,
} from '@/app-layer/usecases/sandbox-runtime-config';

import {
    displayForChannel,
    displayForEnforcement,
    displayForExecutionSwitch,
    type RuntimeRowDisplay,
    type RuntimeRowKind,
} from './sandbox-runtime-display';

/**
 * The declaration as it crosses the server/client boundary: `appliedAt` travels
 * as ISO text rather than a `Date`, so the row renders the same string the
 * deploy recorded instead of one re-derived from the viewer's locale.
 */
export interface SandboxRuntimeView extends Omit<SandboxRuntimeDeclaration, 'appliedAt'> {
    readonly appliedAtIso: string | null;
}

/**
 * A TOTAL map, not a function with a default branch. A sixth row kind must be a
 * type error here rather than silently inheriting whatever the fallthrough
 * returned — a renderer that cannot be wrong about a new kind is how a new kind
 * ends up rendered as "fine".
 */
const BADGE_VARIANT: Record<RuntimeRowKind, 'success' | 'neutral' | 'warning'> = {
    // Nothing is wrong: this deploy simply has no sandbox runtime.
    'not-configured': 'neutral',
    // Nothing is wrong: a CI gate holds the value in a committed policy.
    'set-in-code': 'neutral',
    // Something IS wrong: a configuration was declared to a process that did
    // not answer, so the declaration describes nothing that is known to run.
    unreachable: 'warning',
    // The normal state, and not a warning: the declaration is the best
    // available answer and the runtime offers no way to confirm it.
    'declared-not-observed': 'neutral',
    'tenant-switch': 'success',
};

export function SandboxRuntimeClient({
    view,
    platformEnabled,
}: {
    readonly view: SandboxRuntimeView;
    readonly platformEnabled: boolean;
}) {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();

    // The display functions take the declaration, which still types `appliedAt`
    // as a Date. Only the two fields they actually read are reconstructed.
    const declaration: SandboxRuntimeDeclaration = {
        configured: view.configured,
        configDigest: view.configDigest,
        appliedAt: null,
        reachableVersion: view.reachableVersion,
        channels: view.channels,
    };

    function badge(display: RuntimeRowDisplay) {
        return (
            <StatusBadge variant={BADGE_VARIANT[display.kind]}>
                {t(`sandboxRuntime.status.${display.kind}`)}
            </StatusBadge>
        );
    }

    function row(
        key: string,
        name: string,
        description: string,
        display: RuntimeRowDisplay,
        detail: ReactNode,
    ) {
        return (
            <section
                key={key}
                className="space-y-compact rounded-lg border border-border-subtle p-5"
                data-testid={`sandbox-row-${key}`}
                data-display-kind={display.kind}
            >
                <div className="flex items-start justify-between gap-default">
                    <div className="space-y-tight">
                        <div className="flex items-center gap-tight">
                            <Heading level={2}>{name}</Heading>
                            {badge(display)}
                        </div>
                        <p className="max-w-3xl text-sm text-content-muted">{description}</p>
                    </div>
                </div>
                {detail}
            </section>
        );
    }

    return (
        <div className="space-y-section" data-testid="admin-sandbox-runtime">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('nav.sandboxRuntime'), href: tenantHref('/admin/sandbox-runtime') },
                    { label: t('sandboxRuntime.breadcrumb') },
                ]}
            />

            <Heading level={1}>{t('sandboxRuntime.heading')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">{t('sandboxRuntime.intro')}</p>

            {/* Stated ONCE, at the top, rather than repeated on all seven rows.
                It is a fact about the runtime, not about any one setting. */}
            <InlineNotice variant="info" title={t('sandboxRuntime.noReadApiHeading')}>
                {t('sandboxRuntime.noReadApiBody')}
            </InlineNotice>

            {!view.configured && (
                <InlineNotice variant="info" title={t('sandboxRuntime.notConfiguredHeading')}>
                    {t('sandboxRuntime.notConfiguredBody')}
                </InlineNotice>
            )}

            {view.configured && (
                <dl className="space-y-tight text-sm" data-testid="sandbox-provenance">
                    <div className="flex gap-tight">
                        <dt className="text-content-muted">{t('sandboxRuntime.digestLabel')}</dt>
                        <dd className="font-mono">{view.configDigest}</dd>
                    </div>
                    {view.appliedAtIso !== null && (
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.appliedAtLabel')}
                            </dt>
                            <dd className="font-mono">{view.appliedAtIso}</dd>
                        </div>
                    )}
                </dl>
            )}

            <Heading level={2}>{t('sandboxRuntime.sectionChannels')}</Heading>
            {REPORTING_CHANNELS.map((channel) =>
                row(
                    channel.key,
                    t(`sandboxRuntime.channel.${channel.key}.name`),
                    t(`sandboxRuntime.channel.${channel.key}.description`),
                    displayForChannel(channel.key, declaration),
                    <dl className="space-y-tight text-sm">
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.chartKeyLabel')}
                            </dt>
                            <dd className="font-mono" data-testid={`chart-key-${channel.key}`}>
                                {channel.chartKey ?? t('sandboxRuntime.noChartKey')}
                            </dd>
                        </div>
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.envVarsLabel')}
                            </dt>
                            <dd className="font-mono">{channel.envVars.join(', ')}</dd>
                        </div>
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.defaultLabel')}
                            </dt>
                            <dd>
                                {channel.defaultsOn
                                    ? t('sandboxRuntime.defaultsOn')
                                    : t('sandboxRuntime.defaultsOff')}
                            </dd>
                        </div>
                    </dl>,
                ),
            )}

            <Heading level={2}>{t('sandboxRuntime.sectionEnforcement')}</Heading>
            {ENFORCEMENT_SETTINGS.map((setting) =>
                row(
                    setting.key,
                    t(`sandboxRuntime.enforcement.${setting.key}.name`),
                    t(`sandboxRuntime.enforcement.${setting.key}.description`),
                    displayForEnforcement(),
                    <dl className="space-y-tight text-sm">
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.requiredLabel')}
                            </dt>
                            <dd className="font-mono">{setting.required}</dd>
                        </div>
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.policyPathLabel')}
                            </dt>
                            <dd className="font-mono">{setting.policyPath}</dd>
                        </div>
                    </dl>,
                ),
            )}

            <Heading level={2}>{t('sandboxRuntime.sectionExecution')}</Heading>
            {row(
                'execution',
                t('sandboxRuntime.execution.name'),
                t('sandboxRuntime.execution.description'),
                displayForExecutionSwitch(platformEnabled),
                // NO control, even when the platform permits it. The switch and
                // its storage land with #3996, which also has to settle whether
                // a platform-wide capability may be flipped from a TENANT
                // surface at all. A button here would answer that question by
                // accident.
                <InlineNotice variant="info" title={t('sandboxRuntime.executionPendingHeading')}>
                    {t('sandboxRuntime.executionPendingBody')}
                </InlineNotice>,
            )}
        </div>
    );
}
