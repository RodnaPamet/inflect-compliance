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
} from '@/lib/sandbox-runtime/declarations';

import {
    displayForChannel,
    displayForEnforcement,
    displayForExecutionSwitch,
    displayForProvenance,
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
    /**
     * What the reachability probe concluded — 5.6e (#4000).
     *
     * Carried as the OUTCOME rather than inferred from `reachableVersion`,
     * because a null version is produced by three different outcomes and the
     * page must not report a gateway that answered as one that did not.
     */
    readonly probeOutcome: 'not-probed' | 'unreachable' | 'answered' | 'answered-without-version';
    /**
     * When the probe answered — #4572.
     *
     * The answer is reused for up to 30 seconds, including a failed one, because
     * the gateway is stopped most of the time and that is the case that costs
     * the full timeout. A reused verdict must be visible as one: "reachable"
     * from thirty seconds ago is a different claim from "reachable now".
     */
    readonly probedAtIso: string;
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
    // A WARNING, and the strongest signal this page can give: the deploy
    // claims sandboxed execution and declared no runtime for it. Neutral
    // would read as "fine", which is the one thing it is not.
    unconfirmable: 'warning',
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

    // 5.6e (#4000). Built through the display function rather than from `view`
    // directly, so the reachability branch and the "only an `answered` outcome
    // carries a version" rule live in one tested place instead of in JSX.
    const provenance = displayForProvenance(declaration, view.appliedAtIso, view.probeOutcome);

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
                    {/* The reachability probe, BESIDE the digest — 5.6e (#4000).
                        Every branch states what was asked and what answered.
                        None of them names a setting's value: this deployment
                        cannot read one back, and a row claiming otherwise is
                        the failure the whole page exists to avoid. */}
                    <div className="flex gap-tight" data-testid="sandbox-probed-at">
                        <dt className="text-content-muted">
                            {t('sandboxRuntime.probedAtLabel')}
                        </dt>
                        <dd className="font-mono">{view.probedAtIso}</dd>
                    </div>
                    <div className="flex gap-tight" data-testid="sandbox-reachability">
                        <dt className="text-content-muted">
                            {t('sandboxRuntime.reachabilityLabel')}
                        </dt>
                        <dd>
                            {provenance.reachability === 'answered'
                                ? t('sandboxRuntime.reachabilityAnswered', {
                                      version: provenance.reportedVersion ?? '',
                                  })
                                : provenance.reachability === 'answered-without-version'
                                  ? t('sandboxRuntime.reachabilityNoVersion')
                                  : provenance.reachability === 'not-probed'
                                    ? t('sandboxRuntime.reachabilityNotProbed')
                                    : t('sandboxRuntime.reachabilityUnreachable')}
                        </dd>
                    </div>
                </dl>
            )}

            {/* "Reporting channels", NOT "where data can leave" — which is what
                this heading said first and is an overclaim. These four are the
                paths the RUNTIME reports on; traffic from the sandboxed
                workload leaves by a different mechanism entirely, governed by
                the network rules in the next section. An operator reading the
                broader heading over four rows would take those four as the
                complete set of egress paths, which is the same mistake the
                fourth channel's missing chart key produces one level down. A
                claim is a liability for its breadth, so the heading names only
                what it covers and the note points at the rest. */}
            <Heading level={2}>{t('sandboxRuntime.sectionChannels')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">
                {t('sandboxRuntime.sectionChannelsNote')}
            </p>
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
                        {/* 5.6c (#3998): "this is set in code", not a disabled
                            switch — a greyed-out control reads as a permission
                            problem, and an admin who concludes that goes looking
                            for someone to grant it. Said in plain words (#4825):
                            the module path and the check's name are engineering
                            references, kept in `displayForEnforcement().setInCode`
                            and verified by the tier-C guard, not printed. */}
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.policyModuleLabel')}
                            </dt>
                            <dd data-testid={`policy-module-${setting.key}`}>
                                {t('sandboxRuntime.policyModuleValue')}
                            </dd>
                        </div>
                        <div className="flex gap-tight">
                            <dt className="text-content-muted">
                                {t('sandboxRuntime.ciCheckLabel')}
                            </dt>
                            <dd data-testid={`ci-check-${setting.key}`}>
                                {t('sandboxRuntime.ciCheckValue')}
                            </dd>
                        </div>
                    </dl>,
                ),
            )}

            <Heading level={2}>{t('sandboxRuntime.sectionExecution')}</Heading>
            {row(
                'execution',
                t('sandboxRuntime.execution.name'),
                t('sandboxRuntime.execution.description'),
                displayForExecutionSwitch(platformEnabled, view.configured),
                // NO control, by the owner ruling of 2026-10-25: this switch is
                // platform-only, so there is nothing a workspace administrator
                // could flip here and a button would misrepresent who owns the
                // decision. #3996.
                displayForExecutionSwitch(platformEnabled, view.configured).kind ===
                'unconfirmable' ? (
                    <InlineNotice
                        variant="warning"
                        title={t('sandboxRuntime.executionUnconfirmableHeading')}
                    >
                        {t('sandboxRuntime.executionUnconfirmableBody')}
                    </InlineNotice>
                ) : (
                    <InlineNotice variant="info" title={t('sandboxRuntime.executionPlatformHeading')}>
                        {t('sandboxRuntime.executionPlatformBody')}
                    </InlineNotice>
                ),
            )}
        </div>
    );
}
