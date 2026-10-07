'use client';

/**
 * P3 — Identity & access cross-link strip.
 *
 * The identity surfaces (SSO sign-in, SCIM provisioning, Entra ID) and the
 * Integrations hub (where the Okta / Google Workspace *data-sync* connectors
 * live) were seven sibling admin pages with no wayfinding between them. A
 * user landing on SSO to wire Okta login had no signal that the Okta
 * data-sync connector is a *separate* thing under Integrations — and vice
 * versa. This strip makes the identity cluster navigable both ways:
 * sign-in (SSO), provisioning (SCIM), Entra ID, and the connector hub are
 * always one click apart, with the current surface marked.
 */
import type { SVGProps, ReactElement } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Key, Cloud, CircleUser, Plug2 } from '@inflect/ui/components/ui/icons/nucleo';
import { useTenantHref } from '@/lib/tenant-context-provider';

export type IdentitySurface = 'sso' | 'scim' | 'entra' | 'integrations';

type IconCmp = (props: SVGProps<SVGSVGElement>) => ReactElement;

const LINKS: { key: IdentitySurface; href: string; icon: IconCmp }[] = [
    { key: 'sso', href: '/admin/sso', icon: Key },
    { key: 'scim', href: '/admin/scim', icon: Cloud },
    { key: 'entra', href: '/admin/entra', icon: CircleUser },
    { key: 'integrations', href: '/admin/integrations', icon: Plug2 },
];

export function IdentityCrossLinks({ current }: { current: IdentitySurface }) {
    const t = useTranslations('admin.identityNav');
    const tenantHref = useTenantHref();

    return (
        <nav
            aria-label={t('label')}
            className="flex flex-wrap items-center gap-tight text-sm"
        >
            <span className="text-content-muted">{t('label')}</span>
            {LINKS.map(({ key, href, icon: Icon }) => {
                const active = key === current;
                if (active) {
                    return (
                        <span
                            key={key}
                            aria-current="page"
                            className="inline-flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 font-medium text-content-emphasis"
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {t(key)}
                        </span>
                    );
                }
                return (
                    <Link
                        key={key}
                        href={tenantHref(href)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis"
                    >
                        <Icon className="w-3.5 h-3.5" />
                        {t(key)}
                    </Link>
                );
            })}
        </nav>
    );
}
