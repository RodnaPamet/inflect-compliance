/**
 * EI-1 — tenant Entra-ID provider configuration.
 *
 * Stores the per-tenant `TenantIdentityProvider` row (type = ENTRA_ID) whose
 * `configJson` is the validated `EntraProviderConfig`. One Entra provider per
 * tenant (a fixed `name`). Admin-gated; secrets are masked at the route layer.
 *
 * The directory ID decides whose Microsoft sign-ins the workspace's group
 * mappings apply to (`src/lib/auth/entra-group-sync.ts`), so setting the
 * provider up, or changing its directory or client ID, is Owner-tier
 * (`admin.owner_management`), like an SSO provider's trust fields
 * (`src/lib/auth/sso-trust-fields.ts`). An Admin keeps the other settings.
 */
import { RequestContext } from '../types';
import { assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import {
    ENTRA_TRUST_CONFIG_KEYS,
    ENTRA_TRUST_OWNER_TIER_MESSAGE,
    SSO_TRUST_OWNER_TIER_REFUSAL,
} from '@/lib/auth/sso-trust-fields';
import {
    EntraProviderConfigSchema,
    type EntraProviderConfig,
} from '../schemas/entra-provider.schemas';

const ENTRA_PROVIDER_NAME = 'entra-id';

export async function getEntraProvider(ctx: RequestContext) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, (db) =>
        db.tenantIdentityProvider.findFirst({
            where: { tenantId: ctx.tenantId, type: 'ENTRA_ID' },
        }),
    );
}

export async function upsertEntraProvider(
    ctx: RequestContext,
    rawConfig: unknown,
): Promise<{ id: string; config: EntraProviderConfig }> {
    assertCanAdmin(ctx);
    const config = EntraProviderConfigSchema.parse(rawConfig);

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.tenantIdentityProvider.findFirst({
            where: { tenantId: ctx.tenantId, type: 'ENTRA_ID' },
            select: { id: true, configJson: true },
        });

        const stored = (existing?.configJson ?? {}) as Record<string, unknown>;
        const changedFields = existing
            ? ENTRA_TRUST_CONFIG_KEYS.filter(
                  (key) => String(stored[key] ?? '').toLowerCase() !== String(config[key] ?? '').toLowerCase(),
              )
            : ['provider'];
        if (changedFields.length > 0 && !ctx.appPermissions.admin.owner_management) {
            throw forbidden(ENTRA_TRUST_OWNER_TIER_MESSAGE, {
                reason: SSO_TRUST_OWNER_TIER_REFUSAL,
                fields: changedFields,
            });
        }

        const row = existing
            ? await db.tenantIdentityProvider.update({
                  where: { id: existing.id },
                  data: { configJson: config, emailDomains: config.allowedDomains ?? [] },
              })
            : await db.tenantIdentityProvider.create({
                  data: {
                      tenantId: ctx.tenantId,
                      name: ENTRA_PROVIDER_NAME,
                      type: 'ENTRA_ID',
                      isEnabled: true,
                      isEnforced: false,
                      emailDomains: config.allowedDomains ?? [],
                      configJson: config,
                  },
              });

        await logEvent(db, ctx, {
            action: 'UPDATE',
            entityType: 'TenantIdentityProvider',
            entityId: row.id,
            details: `${existing ? 'Updated' : 'Configured'} Entra ID provider`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantIdentityProvider',
                operation: existing ? 'updated' : 'created',
                changedFields: existing ? changedFields : [],
                after: {
                    type: 'ENTRA_ID',
                    groupClaimMode: config.groupClaimMode,
                    enforceGroupGate: config.enforceGroupGate,
                },
                summary: `Entra ID provider ${existing ? 'updated' : 'configured'}`,
            },
        });

        return { id: row.id, config };
    });
}
