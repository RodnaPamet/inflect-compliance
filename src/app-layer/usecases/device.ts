/**
 * device usecase (PR-5) — inventory list, agent-report upsert, and
 * device-token lifecycle. Tenant-scoped via runInTenantContext.
 *
 * Devices are part of the people layer, so viewing is gated by
 * `personnel.view`. Device-agent TOKEN management (issue/revoke) requires
 * `admin.manage` (H3 — a long-lived tenant credential; matches the route +
 * route-permissions.ts). The agent-report path is token-authed, not
 * permission-gated.
 */
import { z } from 'zod';
import type { RequestContext } from '../types';
import { buildSystemContext } from '../context';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden, badRequest } from '@/lib/errors/types';
import { recordDeviceReport } from '@/lib/observability/integration-metrics';

/** H3 — hard ceiling on distinct devices per tenant; bounds a leaked/looping
 * token from creating unlimited rows (which could also poison device checks). */
const MAX_DEVICES_PER_TENANT = 10000;
import { logEvent } from '../events/audit';
import { generateDeviceToken } from '@/lib/auth/device-token-auth';

const PLATFORMS = ['MACOS', 'WINDOWS', 'LINUX'] as const;

export const DeviceReportSchema = z.object({
    serialNumber: z.string().min(1).max(200),
    hostname: z.string().max(255).optional(),
    platform: z.enum(PLATFORMS),
    diskEncrypted: z.boolean().nullish(),
    screenLockEnabled: z.boolean().nullish(),
    antivirusRunning: z.boolean().nullish(),
    passwordManagerPresent: z.boolean().nullish(),
});

function systemCtx(tenantId: string): RequestContext {
    return buildSystemContext({ tenantId, job: 'device-report' });
}

export async function listDevices(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.device.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, serialNumber: true, hostname: true, platform: true, source: true, employeeId: true, diskEncrypted: true, screenLockEnabled: true, antivirusRunning: true, passwordManagerPresent: true, lastCheckIn: true },
            orderBy: [{ platform: 'asc' }, { hostname: 'asc' }],
            take: 500,
        }),
    );
}

/** Token-authed agent report. `tenantId` comes from the verified device token. */
export async function reportDevice(tenantId: string, data: z.infer<typeof DeviceReportSchema>, now: Date = new Date()) {
    const ctx = systemCtx(tenantId);
    return runInTenantContext(ctx, async (db) => {
        const common = {
            hostname: data.hostname ?? null,
            platform: data.platform,
            diskEncrypted: data.diskEncrypted ?? null,
            screenLockEnabled: data.screenLockEnabled ?? null,
            antivirusRunning: data.antivirusRunning ?? null,
            passwordManagerPresent: data.passwordManagerPresent ?? null,
            lastCheckIn: now,
        };
        // H3 — cap NEW devices per tenant. Reporting an existing serial (update)
        // is always allowed; only a brand-new serial past the ceiling is rejected.
        const existing = await db.device.findUnique({
            where: { tenantId_serialNumber: { tenantId, serialNumber: data.serialNumber } },
            select: { id: true },
        });
        if (!existing) {
            const count = await db.device.count({ where: { tenantId } });
            if (count >= MAX_DEVICES_PER_TENANT) {
                throw badRequest(`Device limit reached for this tenant (${MAX_DEVICES_PER_TENANT}).`);
            }
        }
        recordDeviceReport(); // H6 — ingest counter; a looping token spikes the global rate
        return db.device.upsert({
            where: { tenantId_serialNumber: { tenantId, serialNumber: data.serialNumber } },
            create: { tenantId, serialNumber: data.serialNumber, source: 'AGENT', ...common },
            update: { source: 'AGENT', ...common },
        });
    });
}

// ─── Device-agent tokens ───

export async function listDeviceTokens(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.tenantDeviceToken.findMany({
            where: { tenantId: ctx.tenantId },
            select: { id: true, name: true, tokenPrefix: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 200,
        }),
    );
}

export const IssueDeviceTokenSchema = z.object({ name: z.string().min(1).max(120) });

/** Issue a device-agent token. Returns the plaintext ONCE. */
export async function issueDeviceToken(ctx: RequestContext, data: z.infer<typeof IssueDeviceTokenSchema>) {
    // H3 — device tokens are long-lived tenant credentials; require admin.manage
    // to match the route + route-permissions.ts (was personnel.manage||canAdmin,
    // a privilege drift below what the HTTP layer enforces).
    if (!ctx.appPermissions?.admin?.manage) {
        throw forbidden('You do not have permission to manage device tokens.');
    }
    const { plaintext, tokenHash, tokenPrefix } = generateDeviceToken();
    return runInTenantContext(ctx, async (db) => {
        const token = await db.tenantDeviceToken.create({
            data: { tenantId: ctx.tenantId, name: data.name, tokenHash, tokenPrefix, createdById: ctx.userId },
            select: { id: true, name: true, tokenPrefix: true, createdAt: true },
        });
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'TenantDeviceToken',
            entityId: token.id,
            details: `Issued device token: ${token.name}`,
            detailsJson: { category: 'security', entityName: 'TenantDeviceToken', operation: 'created', summary: `Issued device token: ${token.name}` },
        });
        // plaintext returned once; never stored.
        return { ...token, plaintext };
    });
}

export async function revokeDeviceToken(ctx: RequestContext, id: string, now: Date = new Date()) {
    // H3 — device tokens are long-lived tenant credentials; require admin.manage
    // to match the route + route-permissions.ts (was personnel.manage||canAdmin,
    // a privilege drift below what the HTTP layer enforces).
    if (!ctx.appPermissions?.admin?.manage) {
        throw forbidden('You do not have permission to manage device tokens.');
    }
    return runInTenantContext(ctx, async (db) => {
        const res = await db.tenantDeviceToken.updateMany({
            where: { id, tenantId: ctx.tenantId, revokedAt: null },
            data: { revokedAt: now },
        });
        if (res.count > 0) {
            await logEvent(db, ctx, {
                action: 'UPDATE',
                entityType: 'TenantDeviceToken',
                entityId: id,
                details: 'Revoked device token',
                detailsJson: { category: 'security', entityName: 'TenantDeviceToken', operation: 'revoked', summary: 'Revoked device token' },
            });
        }
        return { revoked: res.count > 0 };
    });
}
