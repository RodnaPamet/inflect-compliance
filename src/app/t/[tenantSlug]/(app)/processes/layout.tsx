/**
 * The module gate for the whole process surface.
 *
 * ═══ WHY A LAYOUT AND NOT A CHECK IN EACH PAGE ═══
 *
 * A layout guards the SEGMENT, so every route under `/processes` — today
 * `page.tsx` and `governance/`, and anything added later — is covered by
 * construction. Two per-page checks would have been equivalent on the day they
 * were written and would have diverged the first time somebody added a third
 * route, which is precisely the omission nobody notices: a new page under a
 * disabled module, reachable because the guard lived next door.
 *
 * It is also the only place a SERVER check can cover both. `governance/page.tsx`
 * is a client component and cannot read the setting itself; a client-side guard
 * there would hide the UI while the route still served, which is not a module.
 *
 * ═══ notFound(), NOT A PERMISSION REFUSAL ═══
 *
 * When the module is off this surface does not EXIST for the tenant, and 404 is
 * the honest answer. `ForbiddenPage` would say "you may not open this", sending
 * a reader to an administrator who has nothing to grant them — the permission
 * they would be asking for is not the thing standing in their way.
 *
 * The distinction matters more here than it usually does, because the module is
 * off by default: most tenants that hit this are not being refused, they simply
 * do not have the feature.
 */
import { notFound } from 'next/navigation';

import { getTenantCtx } from '@/app-layer/context';
import { isProcessCanvasEnabled } from '@/app-layer/usecases/process-canvas-module';

export default async function ProcessesLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    // FAIL CLOSED. `getTenantCtx` throwing means we could not establish who is
    // asking or for which tenant — and a module check that cannot identify the
    // tenant has no answer, so it must not produce a permissive one.
    let enabled = false;
    try {
        const ctx = await getTenantCtx({ tenantSlug });
        enabled = await isProcessCanvasEnabled(ctx);
    } catch {
        notFound();
    }

    if (!enabled) notFound();

    return <>{children}</>;
}
