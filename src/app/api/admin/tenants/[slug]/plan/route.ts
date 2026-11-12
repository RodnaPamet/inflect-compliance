/**
 * POST /api/admin/tenants/:slug/plan   { "plan": "PRO" }
 *
 * Platform-admin endpoint for setting a tenant's billing plan by hand. Gated
 * by `PLATFORM_ADMIN_API_KEY` (X-Platform-Admin-Key header).
 *
 * A plan decides what a tenant is entitled to, and in SaaS mode it follows
 * the tenant's Stripe subscription (`src/lib/stripe.ts`, via the Stripe
 * webhook). Setting it is therefore the platform operator's act, never a
 * tenant's: a tenant OWNER could otherwise give their own workspace
 * ENTERPRISE without paying (owner decision 2026-11-12). The tenant-facing
 * `admin/billing/plan` route that did this was removed.
 *
 * Permission: platform-admin-key-gated — does not use requirePermission;
 * excluded from api-permission-coverage.test.ts guardrail with a reason.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { setTenantPlanAsPlatform } from '@/app-layer/usecases/tenant-lifecycle';

const Body = z.object({
    plan: z.enum(['FREE', 'TRIAL', 'PRO', 'ENTERPRISE']),
});

export const POST = withApiErrorHandling(
    async (req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => {
        try {
            verifyPlatformApiKey(req);
        } catch (err) {
            if (err instanceof PlatformAdminError) {
                return NextResponse.json({ error: err.message }, { status: err.status });
            }
            throw err;
        }

        const { slug } = await ctx.params;
        const body = Body.parse(await req.json());
        const result = await setTenantPlanAsPlatform({ tenantSlug: slug, plan: body.plan });
        return NextResponse.json(result, { status: 200 });
    },
);
