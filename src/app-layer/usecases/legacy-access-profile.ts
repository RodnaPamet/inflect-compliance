/**
 * Profiling a legacy connection's columns, so an administrator can map them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A PROFILE IS NOT A SNAPSHOT, AND NOTHING HERE PERSISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No `LegacyAccessSnapshot`, no `LegacyAccount`, no payload hash, no row. A
 * profile is scaffolding for a decision somebody is about to make, and
 * recertification reads only `COMPLETE` snapshots — so a profile cannot become
 * evidence by accident, because it never becomes a row at all.
 *
 * That separation is what licenses the one way profiling is BROADER than a pull:
 * it requests every column that is not denylisted, where a pull requests only the
 * mapped ones. You cannot map a column you were never shown, and at profiling
 * time no mapping exists. The denylist is what keeps that from being a widening —
 * a denied name is excluded here exactly as it is excluded from a pull, so the
 * sensitive columns are never requested at either stage.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY TWO ROUND TRIPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `probeManifest` first, to learn the column names; then `profileFirstPage` with
 * the non-denylisted subset as an explicit projection. One call would be enough
 * if the transport applied the denylist itself — and it must not. The denylist is
 * product policy, the same kind of thing as `LEGACY_SNAPSHOT_MAX_ACCOUNTS` and the
 * oversharing severity rule, and `lib/mcp/client` deliberately knows none of them.
 * Pushing it down there to save a handshake would buy one round trip on an
 * interactive action and cost the property that the transport decides nothing.
 *
 * @module app-layer/usecases/legacy-access-profile
 */

import { probeManifest, profileFirstPage } from '@/lib/mcp/client';
import { LEGACY_MCP_PROVIDER_ID } from '@/app-layer/integrations/providers/legacy-mcp';
import { runInTenantContext } from '@/lib/db-context';
import { decryptField } from '@/lib/security/encryption';
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import {
    computeColumnSetFingerprint,
    diffColumnSets,
    isDeniedColumn,
    type ColumnSetDiff,
} from '@/lib/legacy-access/canonical';
import { computeColumnProfiles, type ColumnProfile } from '@/lib/legacy-access/profile';
import { suggestMapping, type ColumnSuggestion } from '@/lib/legacy-access/mapping-suggest';
import type { RequestContext } from '../types';
import { assertCanAdmin } from '../policies/common';
import { readStoredMapping } from './legacy-access-mapping';

export interface ProfileResult {
    /** The app the far end says it is fronting. Operator-authored, safe to render. */
    readonly application: { readonly name: string; readonly owner: string };
    /** Every column the server declares, including denylisted ones — see `denied`. */
    readonly columns: readonly ProfiledColumn[];
    /** The fingerprint of the CURRENT column set, for the caller to confirm against. */
    readonly columnSetFingerprint: string;
    /** Every column name the server declares, so a save can store what was confirmed. */
    readonly observedColumns: readonly string[];
    /** The server's own declared entitlement layout, as a default for the picker. */
    readonly declaredLayout: 'wide' | 'long';
    /** Rows the profile looked at. The denominator for every share on every column. */
    readonly rowsSampled: number;
    /** True when the table has more pages than the profile read. Not a fault. */
    readonly truncated: boolean;
    /** Columns the server volunteered against an explicit projection. Names only. */
    readonly overshared: readonly string[];
    /**
     * Against the mapping in force, when there is one: which columns appeared and
     * which vanished since it was confirmed. This is what a drift refusal shows,
     * and `indeterminate` is true for a mapping saved before the column names were
     * stored alongside their hash.
     */
    readonly drift: ColumnSetDiff | null;
    /** The version in force, or null when no mapping is saved. */
    readonly mappingVersion: number | null;
}

export interface ProfiledColumn {
    readonly profile: ColumnProfile;
    readonly suggestion: ColumnSuggestion;
}

/**
 * Profile a connection's columns.
 *
 * `assertCanAdmin`, because the response enumerates a customer's legacy schema and
 * because the only thing anybody does with it is save a mapping, which decides
 * which column means `email` — one of the four signals that can reach `LINKED`
 * with nobody looking.
 */
export async function profileLegacyConnection(
    ctx: RequestContext,
    connectionId: string
): Promise<ProfileResult> {
    assertCanAdmin(ctx);

    const conn = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirstOrThrow({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { id: true, provider: true, configJson: true, secretEncrypted: true },
        })
    );

    // Refused for any other provider, by NAME rather than by whether it happens
    // to carry an `endpointUrl`. Without this an `entra-id` connection reaches the
    // credential check below and is told it is "missing its endpoint or bearer
    // token" — true, and a useless thing to tell somebody about a connection that
    // was never meant to have one.
    if (conn.provider !== LEGACY_MCP_PROVIDER_ID) {
        throw badRequest(
            `Column profiling applies to ${LEGACY_MCP_PROVIDER_ID} connections; this one is `
            + `${conn.provider}.`
        );
    }

    const config = (conn.configJson ?? {}) as Record<string, unknown>;
    const url = typeof config.endpointUrl === 'string' ? config.endpointUrl.trim() : '';
    const token = readBearerToken(conn.secretEncrypted);
    if (!url || !token) {
        throw badRequest('This connection is missing its endpoint or bearer token.');
    }

    // ── 1. The column names, so the projection can exclude the denylist ────
    const manifest = await probeManifest({ url, token });
    const declared = manifest.columns.map((c) => c.name);
    const requestable = declared.filter((c) => !isDeniedColumn(c));

    if (requestable.length === 0) {
        // Every column the server declares is denylisted. Refused rather than
        // profiled with an empty projection, which the transport would reject as
        // an undeclared-columns request anyway — this says why.
        throw badRequest(
            'Every column this server declares is on the never-request denylist, so there '
            + 'is nothing that may be profiled or mapped.'
        );
    }

    // ── 2. One page, with that projection ──────────────────────────────────
    const read = await profileFirstPage({ url, token, fields: requestable });

    // ── 3. Statistics, then the rows go away ───────────────────────────────
    // `computeColumnProfiles` returns counts and shares; the rows it was given
    // are not referenced after this line and nothing else in this function has
    // them. That is the whole boundary — see lib/legacy-access/profile.ts.
    const profiles = computeColumnProfiles(read.rows, requestable);
    const suggestions = suggestMapping(profiles);

    const columns: ProfiledColumn[] = profiles.map((profile, i) => ({
        profile,
        suggestion: suggestions[i],
    }));

    // Denylisted columns appear in the response as unmappable entries with NO
    // profile data, so the screen can show the operator that the column exists and
    // was deliberately not read. Omitting them entirely would leave them
    // wondering where `PASSWORD_HASH` went; profiling them would be the thing the
    // denylist exists to prevent.
    const deniedColumns = declared.filter(isDeniedColumn).sort();

    const stored = readStoredMapping(conn.configJson);
    const fingerprint = computeColumnSetFingerprint(declared);

    logger.info('legacy access connection profiled', {
        component: 'legacy-access',
        connectionId: conn.id,
        // Counts and a layout. Never a column name, never a value — a log line is
        // the wrong place to accumulate a customer's schema.
        columns: declared.length,
        denied: deniedColumns.length,
        rowsSampled: read.rows.length,
        truncated: read.truncated,
    });

    return {
        application: { name: manifest.app.name, owner: manifest.app.owner },
        columns: [...columns, ...deniedColumns.map(deniedEntry)],
        columnSetFingerprint: fingerprint,
        observedColumns: declared,
        declaredLayout: manifest.layout,
        rowsSampled: read.rows.length,
        truncated: read.truncated,
        overshared: read.overshared,
        drift: stored ? diffColumnSets(stored, declared) : null,
        mappingVersion: stored?.version ?? null,
    };
}

/**
 * A denylisted column, shown as present and unmappable.
 *
 * Every statistic is zero because nothing was read — which is the honest shape.
 * A caller cannot distinguish this from an empty column by the numbers alone, so
 * `suggestion.denied` is what the screen keys on.
 */
function deniedEntry(name: string): ProfiledColumn {
    return {
        profile: {
            name,
            rowsSampled: 0,
            nonNullCount: 0,
            distinctCount: 0,
            emailShare: 0,
            dateShare: 0,
            integerShare: 0,
            booleanShare: 0,
            maxLength: 0,
        },
        suggestion: {
            column: name,
            suggested: null,
            basis: null,
            confidence: 0,
            denied: true,
            note: 'On the never-request denylist. It was not requested, not read and cannot be mapped.',
        },
    };
}

function readBearerToken(encrypted: string | null): string {
    if (!encrypted) return '';
    try {
        const parsed: unknown = JSON.parse(decryptField(encrypted));
        if (!parsed || typeof parsed !== 'object') return '';
        const token = (parsed as Record<string, unknown>).bearerToken;
        return typeof token === 'string' ? token.trim() : '';
    } catch {
        // A secret that will not decrypt reads as absent, which the caller turns
        // into a `badRequest` naming the missing credential. Rethrowing would
        // surface a decryption message about a token.
        return '';
    }
}
