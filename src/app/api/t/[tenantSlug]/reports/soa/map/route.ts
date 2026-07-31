import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanWrite } from '@/app-layer/policies/common';
import { logEvent } from '@/app-layer/events/audit';
import { jsonResponse } from '@/lib/api-response';
import { notFound } from '@/lib/errors/types';

// ─── Map a control to a requirement ───

const MapBody = z.object({
    requirementId: z.string().min(1),
    controlId: z.string().min(1),
}).strip();

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    assertCanWrite(ctx);

    const body = MapBody.parse(await req.json());

    const result = await runInTenantContext(ctx, async (db) => {
        // Verify control belongs to tenant.
        //
        // `new Error` bypassed the error taxonomy entirely: withApiErrorHandling
        // maps typed errors to their status and everything else to 500, so a
        // caller naming a control that does not exist (or belongs to another
        // tenant) got a 500 — an "our fault" answer to a "your request" problem,
        // and one that pages an on-call for a client bug.
        const control = await db.control.findFirst({
            where: { id: body.controlId, tenantId: ctx.tenantId },
            select: { id: true, code: true, name: true },
        });
        if (!control) throw notFound('Control not found');

        // Verify the requirement exists BEFORE the upsert.
        //
        // It was never checked, so a bogus requirementId reached Postgres and
        // surfaced as a raw foreign-key violation — a 500 carrying a constraint
        // name, which tells the caller nothing and tells the log reader that the
        // database rejected something rather than that the input was wrong.
        const requirement = await db.frameworkRequirement.findFirst({
            where: { id: body.requirementId },
            select: { id: true },
        });
        if (!requirement) throw notFound('Requirement not found');

        // Upsert mapping
        const link = await db.controlRequirementLink.upsert({
            where: {
                controlId_requirementId: {
                    controlId: body.controlId,
                    requirementId: body.requirementId,
                },
            },
            create: {
                tenantId: ctx.tenantId,
                controlId: body.controlId,
                requirementId: body.requirementId,
            },
            update: {},
        });

        await logEvent(db, ctx, {
            action: 'SOA_CONTROL_MAPPED',
            entityType: 'ControlRequirementLink',
            entityId: link.id,
            details: `Mapped control ${control.code || control.id} to requirement ${body.requirementId}`,
        });

        return link;
    });

    return jsonResponse(result, { status: 201 });
});
