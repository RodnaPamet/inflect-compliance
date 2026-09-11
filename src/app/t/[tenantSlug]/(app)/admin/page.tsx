import { getTranslations } from 'next-intl/server';
import { Shield, CreditCard, KeyRound, ShieldCheck, ShieldPlus, Users, UserCog, CloudCog, Plug, Palette, Grid3x3, Gauge, Bell, ScrollText, Globe, Laptop, GraduationCap, ClipboardList, ClipboardCheck, Lock } from 'lucide-react';
import { Robot } from '@/components/ui/icons/nucleo';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button-variants';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { PageHeader } from '@/components/layout/PageHeader';
import { Eyebrow } from '@/components/ui/typography';

export const dynamic = 'force-dynamic';

/**
 * Admin landing — pure pill-nav surface.
 *
 * R13-PR10 retired the embedded audit log tab and the policy
 * templates tab. Audit log now lives at its own page
 * (`/admin/audit-log`) reachable via the pill next to
 * Notifications. Policy templates were unused chrome and were
 * dropped entirely.
 */
export default async function AdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    const t = await getTranslations('admin');

    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;

    const iconCls = 'w-3.5 h-3.5';
    const sections: {
        title: string;
        pills: { href: string; id: string; icon: React.ReactNode; label: string }[];
    }[] = [
        {
            title: t('section.identity'),
            pills: [
                { href: '/admin/sso', id: 'sso-pill-btn', icon: <KeyRound className={iconCls} />, label: t('nav.sso') },
                { href: '/admin/scim', id: 'scim-pill-btn', icon: <CloudCog className={iconCls} />, label: t('nav.scim') },
                { href: '/admin/entra', id: 'entra-pill-btn', icon: <UserCog className={iconCls} />, label: t('nav.entra') },
            ],
        },
        {
            title: t('section.integrations'),
            pills: [
                { href: '/admin/integrations', id: 'integrations-pill-btn', icon: <Plug className={iconCls} />, label: t('nav.integrations') },
            ],
        },
        {
            title: t('section.people'),
            pills: [
                { href: '/admin/members', id: 'members-pill-btn', icon: <Users className={iconCls} />, label: t('nav.members') },
                { href: '/admin/rbac', id: 'rbac-pill-btn', icon: <Shield className={iconCls} />, label: t('nav.rbac') },
                { href: '/admin/roles', id: 'custom-roles-pill-btn', icon: <ShieldPlus className={iconCls} />, label: t('nav.roles') },
                { href: '/admin/personnel', id: 'personnel-pill-btn', icon: <Users className={iconCls} />, label: t('nav.personnel') },
                { href: '/admin/devices', id: 'devices-pill-btn', icon: <Laptop className={iconCls} />, label: t('nav.devices') },
                { href: '/admin/training', id: 'training-pill-btn', icon: <GraduationCap className={iconCls} />, label: t('nav.training') },
            ],
        },
        {
            title: t('section.organization'),
            pills: [
                { href: '/admin/api-keys', id: 'api-keys-pill-btn', icon: <KeyRound className={iconCls} />, label: t('nav.apiKeys') },
                { href: '/admin/billing', id: 'billing-pill-btn', icon: <CreditCard className={iconCls} />, label: t('nav.billing') },
                { href: '/admin/notifications', id: 'notifications-pill-btn', icon: <Bell className={iconCls} />, label: t('nav.notifications') },
            ],
        },
        {
            title: t('section.security'),
            pills: [
                { href: '/admin/security', id: 'security-pill-btn', icon: <ShieldCheck className={iconCls} />, label: t('nav.security') },
                { href: '/admin/trust-center', id: 'trust-center-pill-btn', icon: <Globe className={iconCls} />, label: t('nav.trustCenter') },
                { href: '/admin/audit-log', id: 'audit-log-pill-btn', icon: <ScrollText className={iconCls} />, label: t('auditLog') },
                // AGENTIC UI 1/4 (#2442): the agent register, the proposal
                // queue, activity, receipts and quarantine all moved out from
                // behind this pill to `/agents`, a sidebar destination. What
                // remains behind it is the MCP credential-binding panel, so
                // the pill now names that rather than the protocol.
                //
                // The label was a BARE LITERAL "MCP" — the only pill on this
                // page that was not a `t()` key, so the one pill whose label
                // could not be translated was also the one whose label was an
                // acronym. Both halves fixed here.
                { href: '/admin/mcp', id: 'mcp-pill-btn', icon: <Robot className={iconCls} />, label: t('nav.mcp') },
            ],
        },
        {
            // Privacy is its own domain rather than a Security pill: the page
            // spans residency, retention, sub-processors and DSAR posture, and
            // grouping it under Security would bury the data-protection story
            // that a DPO or auditor comes looking for.
            title: t('section.privacyData'),
            pills: [
                { href: '/admin/privacy', id: 'privacy-pill-btn', icon: <Lock className={iconCls} />, label: t('nav.privacy') },
                { href: '/admin/dsar-requests', id: 'dsar-requests-pill-btn', icon: <ClipboardList className={iconCls} />, label: t('nav.dsarRequests') },
            ],
        },
        {
            title: t('section.risk'),
            pills: [
                { href: '/admin/risk-matrix', id: 'risk-matrix-pill-btn', icon: <Grid3x3 className={iconCls} />, label: t('nav.riskMatrix') },
                { href: '/admin/risk-appetite', id: 'risk-appetite-pill-btn', icon: <Gauge className={iconCls} />, label: t('nav.riskAppetite') },
            ],
        },
        {
            title: t('section.vendors'),
            pills: [
                { href: '/admin/vendor-templates', id: 'vendor-templates-pill-btn', icon: <ClipboardList className={iconCls} />, label: t('nav.vendorTemplates') },
                { href: '/admin/vendor-assessment-reviews', id: 'vendor-reviews-pill-btn', icon: <ClipboardCheck className={iconCls} />, label: t('nav.vendorReviews') },
            ],
        },
    ];

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                breadcrumbs={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('title') },
                ]}
                title={t('title')}
                actions={
                    <div
                        className="flex items-center gap-compact rounded-lg border border-border-subtle bg-bg-default px-3 py-1.5"
                        id="admin-theme-section"
                    >
                        <Palette className="w-4 h-4 text-content-muted" />
                        <span className="text-sm text-content-muted">{t('nav.theme')}</span>
                        <ThemeToggle id="admin-theme-toggle" />
                    </div>
                }
            />

            {/* Navigation pills — grouped by admin domain (P3). */}
            {sections.map((section) => (
                <section key={section.title} className="space-y-default" aria-label={section.title}>
                    <Eyebrow>{section.title}</Eyebrow>
                    <div className="flex gap-tight flex-wrap">
                        {section.pills.map((pill) => (
                            <Link
                                key={pill.id}
                                href={tenantHref(pill.href)}
                                className={buttonVariants({ variant: 'secondary' })}
                                id={pill.id}
                            >
                                {pill.icon}
                                {pill.label}
                            </Link>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
