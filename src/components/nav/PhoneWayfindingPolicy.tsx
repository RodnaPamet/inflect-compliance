'use client';

/**
 * The tenant app's phone wayfinding rule, supplied to the shared page header
 * through `PhoneBreadcrumbsPolicy` (#5822): on a subpage that owes a back link,
 * a phone shows the back link and no inline breadcrumb trail.
 *
 * It lives here, in product code, because the rule reads the product's route
 * registry; the shared header and `PageBreadcrumbs` only ask the slot.
 */
import type { ReactNode } from 'react';
import { PhoneBreadcrumbsPolicy } from '@/components/layout/breadcrumbs-store';
import { phoneShowsBackLinkOnly } from '@/lib/nav/mobile-wayfinding';

const showsBreadcrumbsOnAPhone = (pathname: string) =>
    !phoneShowsBackLinkOnly(pathname);

export function PhoneWayfindingPolicy({ children }: { children: ReactNode }) {
    return (
        <PhoneBreadcrumbsPolicy.Provider value={showsBreadcrumbsOnAPhone}>
            {children}
        </PhoneBreadcrumbsPolicy.Provider>
    );
}
