import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createAuditCycle, listAuditCycles } from '@/app-layer/usecases/audit-readiness';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const CreateCycleSchema = z.object({
    // ANY installed framework, not an allowlist. `createAuditCycle` already
    // validates the key against the tenant's installed Framework rows and
    // throws `badRequest('frameworkKey must be an installed framework')` —
    // that is the correct gate, and this enum was making it unreachable for
    // every key outside the two seeds.
    //
    // The cost was not theoretical: the picker at cycles/page.tsx fetches
    // /frameworks and offers every installed framework, so a tenant with
    // SOC 2 / CIS / SSDF / NIST Privacy saw them listed and got a 400
    // invalid_enum_value on submit. It also left `computeGenericReadiness`
    // — the whole non-ISO/NIS2 scoring branch — as dead code.
    //
    // Do NOT re-add an enum here. Listing more keys just moves the same wall
    // to the next framework someone installs.
    frameworkKey: z.string().min(1),
    frameworkVersion: z.string().min(1),
    name: z.string().min(1).max(200),
    periodStartAt: z.string().optional(),
    periodEndAt: z.string().optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await listAuditCycles(ctx));
});

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = CreateCycleSchema.parse(await req.json());
    return jsonResponse(await createAuditCycle(ctx, body), { status: 201 });
});
