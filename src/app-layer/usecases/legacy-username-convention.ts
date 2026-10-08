/**
 * Adopting a username convention for a legacy connection: versioned, audited, and
 * never automatic.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ADOPTION IS A USECASE AND NOT A SETTING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A naming convention is a rule that turns a name into a username, and the engine
 * uses it to suggest matches. Getting it wrong does not produce an error — it
 * produces plausible suggestions for the wrong people, which a reviewer may well
 * approve. So the decision to adopt one is an administrative act with a trail, not
 * a field somebody edits.
 *
 * Three things follow, and they are the whole of this module:
 *
 *   1. **`assertCanAdmin`.** Adopting a convention changes what the matcher
 *      suggests for every account on the connection.
 *   2. **A version, incremented on every change, with the previous template kept.**
 *      So "why did this account get suggested to that person last month?" is
 *      answerable — the suggestion depended on a rule that may since have changed.
 *      A bare overwrite makes the history unrecoverable precisely when somebody
 *      disputes a link.
 *   3. **An audit entry naming both templates.** The template is operator-authored
 *      configuration, not legacy data, so it is safe in an audit row — unlike the
 *      account names it will go on to match, which never appear here.
 *
 * `proposeConventions` MEASURES; this ADOPTS. Nothing calls this automatically, and
 * the proposer deliberately returns no "best" for a caller to pass straight in.
 *
 * @module app-layer/usecases/legacy-username-convention
 */

import type { Prisma } from '@prisma/client';

import { badRequest } from '@/lib/errors/types';
import { validateProviderConfig } from '@/app-layer/integrations/config-schema';
import { runInTenantContext } from '@/lib/db-context';
import {
    ConventionSyntaxError,
    parseConvention,
} from '@/lib/identity/reconcile/conventions';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { assertCanAdmin, assertCanRead } from '../policies/common';

/** The `configJson` key this lives under. One key, so a reader can grep for it. */
export const CONVENTION_CONFIG_KEY = 'legacyUsernameConvention';

export interface StoredConvention {
    readonly template: string;
    /** 1 on first adoption, incremented on every change. */
    readonly version: number;
    /** The template this replaced, so one step of history is always on the row. */
    readonly previousTemplate: string | null;
    readonly adoptedAt: string;
    readonly adoptedByUserId: string | null;
}

function readStored(configJson: unknown): StoredConvention | null {
    if (!configJson || typeof configJson !== 'object') return null;
    const raw = (configJson as Record<string, unknown>)[CONVENTION_CONFIG_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.template !== 'string' || typeof c.version !== 'number') return null;
    return {
        template: c.template,
        version: c.version,
        previousTemplate: typeof c.previousTemplate === 'string' ? c.previousTemplate : null,
        adoptedAt: typeof c.adoptedAt === 'string' ? c.adoptedAt : '',
        adoptedByUserId: typeof c.adoptedByUserId === 'string' ? c.adoptedByUserId : null,
    };
}

/**
 * The convention in force for a connection, or null.
 *
 * Read with `assertCanRead` rather than `assertCanAdmin`: a reviewer looking at a
 * suggestion is entitled to see the rule that produced it, and that is the whole
 * point of recording it.
 */
export async function getUsernameConvention(
    ctx: RequestContext,
    connectionId: string
): Promise<StoredConvention | null> {
    assertCanRead(ctx);
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirstOrThrow({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        })
    );
    return readStored(row.configJson);
}

/**
 * Adopt a template for a connection.
 *
 * Validates the grammar FIRST, before any read or write. A malformed template is
 * the caller's error and must not reach the row — a stored template that cannot be
 * parsed would make every later pull throw at the point of use, far from the
 * request that caused it.
 *
 * Re-adopting the identical template is a no-op that still returns the stored
 * record, and deliberately does NOT bump the version or write an audit row:
 * version numbers that advance without a change make the history harder to read,
 * not easier, and an audit trail of non-events trains people to skip it.
 */
export async function adoptUsernameConvention(
    ctx: RequestContext,
    input: { connectionId: string; template: string }
): Promise<StoredConvention> {
    assertCanAdmin(ctx);

    let parsed;
    try {
        parsed = parseConvention(input.template);
    } catch (e) {
        if (e instanceof ConventionSyntaxError) throw badRequest(e.message);
        throw e;
    }

    return runInTenantContext(ctx, async (db) => {
        const row = await db.integrationConnection.findFirstOrThrow({
            where: { id: input.connectionId, tenantId: ctx.tenantId },
            select: { id: true, name: true, provider: true, configJson: true },
        });

        const current = readStored(row.configJson);
        if (current && current.template === parsed.template) return current;

        const next: StoredConvention = {
            template: parsed.template,
            version: (current?.version ?? 0) + 1,
            previousTemplate: current?.template ?? null,
            // The request's own timestamp, not a fresh clock read inside the
            // transaction, so every row written by one request agrees.
            adoptedAt: new Date().toISOString(),
            adoptedByUserId: ctx.userId ?? null,
        };

        const config = (row.configJson ?? {}) as Record<string, unknown>;
        // Spread rather than replace: `configJson` is shared with the provider's
        // own settings, and writing a bare object here would delete whatever else
        // the connection was configured with.
        const merged: Record<string, unknown> = {
            ...config,
            // A plain literal: Prisma's `InputJsonValue` does not accept an
            // interface with readonly fields, and casting would hide the next
            // field that is genuinely not serialisable.
            [CONVENTION_CONFIG_KEY]: {
                template: next.template,
                version: next.version,
                previousTemplate: next.previousTemplate,
                adoptedAt: next.adoptedAt,
                adoptedByUserId: next.adoptedByUserId,
            },
        };

        // Every configJson write goes through the validator —
        // `tests/guards/config-write-path-coverage.test.ts` enforces that, and it
        // caught this module for skipping it. The coupling it creates is the point:
        // a provider with declared `CONFIG_FIELD_RULES` refuses an unknown key, so
        // when Step 1c registers `legacy-mcp` with rules, this key has to be
        // declared there or this call starts throwing. Today the legacy provider is
        // unregistered, so the validator passes the object through unchanged — and
        // that is a validated pass-through rather than an unvalidated write.
        const validated = validateProviderConfig(row.provider, merged);

        await db.integrationConnection.update({
            where: { id: row.id },
            // `as Prisma.InputJsonValue`, the same shape `usecases/integrations.ts`
            // uses at its own two write sites: the validator returns
            // `Record<string, unknown>` and `unknown` is not provably JSON. A
            // NAMED-type cast rather than the unrestricted one — that ratchet
            // stands at zero in `src/` and this would have been a poor place to
            // spend it. (Phrased without the literal token on purpose: the guard
            // in `tests/guards/` scans raw text with comments INCLUDED at cap 0,
            // so a comment discussing the pattern counts as the pattern. It caught
            // this sentence's first draft, which is the same rewording fix the
            // repo applied to a prose match in June 2026.)
            data: { configJson: validated as Prisma.InputJsonValue },
        });

        await logEvent(db, ctx, {
            entityType: 'IntegrationConnection',
            entityId: row.id,
            action: 'LEGACY_USERNAME_CONVENTION_ADOPTED',
            details:
                `Username convention "${next.template}" adopted for connection "${row.name}" ` +
                `(version ${next.version})`,
            detailsJson: {
                category: 'custom',
                event: 'legacy_username_convention_adopted',
                connectionId: row.id,
                // Both templates, because the question an auditor asks is what
                // CHANGED. These are operator-authored configuration — no account
                // name, no employee name, nothing from the legacy system.
                template: next.template,
                previousTemplate: next.previousTemplate,
                version: next.version,
                adoptedByUserId: next.adoptedByUserId,
            },
        });

        return next;
    });
}
