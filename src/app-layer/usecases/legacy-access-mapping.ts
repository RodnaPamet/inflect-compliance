/**
 * Saving the column mapping for a legacy access connection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SAVING A MAPPING IS AN ADMINISTRATIVE ACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A mapping decides which legacy column means `email` and which means
 * `employeeNumber` — and both of those are STRONG signals, the kind that can
 * produce a `LINKED` with no human looking at it. A mapping that names the wrong
 * column does not produce an error; it produces confident links between the wrong
 * people. So this is `assertCanAdmin`, versioned, and audited, for the same
 * reasons `adoptUsernameConvention` is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DENYLIST RUNS HERE, WHICH IS EARLIER THAN IT LOOKS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Refusing a denied column at SAVE time is what keeps it from ever being
 * REQUESTED: the projection sent to the far end is derived from the mapping, so a
 * column that cannot be mapped is a column that never appears in a `?fields=`
 * list and never crosses the network. Checking at ingestion instead would mean the
 * value had already been read into this process before we declined to store it —
 * a defence that runs after the data arrives is a filter, not a boundary.
 *
 * Ingestion checks it again anyway, because a server may volunteer a column
 * nobody asked for. Two checks, two different failures.
 *
 * @module app-layer/usecases/legacy-access-mapping
 */

import type { Prisma } from '@prisma/client';

import { badRequest } from '@/lib/errors/types';
import { validateProviderConfig } from '@/app-layer/integrations/config-schema';
import { runInTenantContext } from '@/lib/db-context';
import {
    LegacyMappingError,
    MAPPING_CONFIG_KEY,
    StoredMappingSchema,
    assertMappingUsable,
    projectedColumns,
    type CanonicalStatus,
    type EntitlementLayout,
    type StoredMapping,
} from '@/lib/legacy-access/canonical';
import type { RequestContext } from '../types';
import { logEvent } from '../events/audit';
import { assertCanAdmin, assertCanRead } from '../policies/common';

export interface SaveMappingInput {
    readonly connectionId: string;
    /** canonical field → source column. Validated against the canonical field set. */
    readonly fields: Readonly<Record<string, string>>;
    readonly entitlements: EntitlementLayout;
    readonly statusValues?: Readonly<Record<string, CanonicalStatus>>;
    /**
     * The column set the administrator confirmed this mapping against.
     *
     * Supplied by the CALLER rather than read from the server here, and that is
     * deliberate: re-reading the manifest at save time would let the fingerprint
     * describe a column set nobody looked at. The person confirming the mapping saw
     * a particular set of columns, and this is the record of WHICH.
     */
    readonly columnSetFingerprint: string;
    /**
     * The column names the fingerprint was taken over, so a later drift refusal
     * can show WHICH columns moved. Optional on the wire for the same
     * backward-compatibility reason the stored field is optional.
     */
    readonly confirmedColumns?: readonly string[];
}

/** Read the mapping in force. `assertCanRead`, because a reviewer may see why a row says what it says. */
export async function getLegacyAccessMapping(
    ctx: RequestContext,
    connectionId: string
): Promise<StoredMapping | null> {
    assertCanRead(ctx);
    const row = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirstOrThrow({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: { configJson: true },
        })
    );
    return readStoredMapping(row.configJson);
}

/** Parse a stored mapping, or null. Never throws on a malformed stored value. */
export function readStoredMapping(configJson: unknown): StoredMapping | null {
    if (!configJson || typeof configJson !== 'object') return null;
    const raw = (configJson as Record<string, unknown>)[MAPPING_CONFIG_KEY];
    if (!raw) return null;
    const parsed = StoredMappingSchema.safeParse(raw);
    // A stored value that no longer parses reads as ABSENT rather than throwing.
    // The pull turns an absent mapping into a named `MAPPING_MISSING` refusal on a
    // snapshot row; a throw here would instead surface as an unhandled job error
    // with no snapshot to look at, which is strictly less information.
    return parsed.success ? parsed.data : null;
}

/**
 * Save a mapping, bumping its version.
 *
 * Validation runs BEFORE any read or write, and reports every problem at once.
 * Re-saving an identical mapping against an identical fingerprint is a no-op that
 * does not bump the version or write an audit row — version numbers that advance
 * without a change make the history harder to read, and an audit trail of
 * non-events trains people to skip it.
 */
export async function saveLegacyAccessMapping(
    ctx: RequestContext,
    input: SaveMappingInput
): Promise<StoredMapping> {
    assertCanAdmin(ctx);

    return runInTenantContext(ctx, async (db) => {
        const row = await db.integrationConnection.findFirstOrThrow({
            where: { id: input.connectionId, tenantId: ctx.tenantId },
            select: { id: true, name: true, provider: true, configJson: true },
        });

        const current = readStoredMapping(row.configJson);

        const candidate = {
            version: (current?.version ?? 0) + 1,
            columnSetFingerprint: input.columnSetFingerprint,
            ...(input.confirmedColumns ? { confirmedColumns: [...input.confirmedColumns] } : {}),
            fields: input.fields,
            entitlements: input.entitlements,
            statusValues: input.statusValues,
            // The request's own clock, not a fresh read inside the transaction, so
            // every row written by one request agrees about when it happened.
            confirmedAt: new Date().toISOString(),
            confirmedByUserId: ctx.userId ?? null,
        };

        const parsed = StoredMappingSchema.safeParse(candidate);
        if (!parsed.success) {
            // Paths only. A Zod message can quote the received value, and a field
            // value here is an operator-typed column name — harmless — but the same
            // habit applied at ingestion would echo legacy data, so the habit is
            // worth keeping uniform.
            const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].sort();
            throw badRequest(`Invalid mapping shape at: ${paths.join(', ')}`);
        }
        const mapping = parsed.data;

        try {
            assertMappingUsable(mapping);
        } catch (e) {
            if (e instanceof LegacyMappingError) throw badRequest(e.message);
            throw e;
        }

        if (current && sameMapping(current, mapping)) return current;

        const config = (row.configJson ?? {}) as Record<string, unknown>;
        // Spread rather than replace: `configJson` is shared with the provider's own
        // settings and with Step 4a's username convention. Writing a bare object
        // here would delete both.
        const merged: Record<string, unknown> = {
            ...config,
            [MAPPING_CONFIG_KEY]: {
                version: mapping.version,
                columnSetFingerprint: mapping.columnSetFingerprint,
                ...(mapping.confirmedColumns
                    ? { confirmedColumns: [...mapping.confirmedColumns] }
                    : {}),
                fields: { ...mapping.fields },
                entitlements: mapping.entitlements,
                ...(mapping.statusValues ? { statusValues: { ...mapping.statusValues } } : {}),
                confirmedAt: mapping.confirmedAt,
                confirmedByUserId: mapping.confirmedByUserId,
            },
        };

        // Every configJson write goes through the validator —
        // `tests/guards/config-write-path-coverage.test.ts` enforces it. For this
        // provider that is not a formality: the rules map is an ALLOWLIST and
        // throws on a key it does not know, so `legacyAccessMapping` had to be
        // declared in `CONFIG_FIELD_RULES` for this line to work at all. See #3315,
        // where the same omission had already broken Step 4a's convention write.
        const validated = validateProviderConfig(row.provider, merged);

        await db.integrationConnection.update({
            where: { id: row.id },
            data: { configJson: validated as Prisma.InputJsonValue },
        });

        await logEvent(db, ctx, {
            entityType: 'IntegrationConnection',
            entityId: row.id,
            action: 'LEGACY_ACCESS_MAPPING_SAVED',
            details:
                `Legacy access mapping version ${mapping.version} saved for connection `
                + `"${row.name}" (${Object.keys(mapping.fields).length} fields mapped)`,
            detailsJson: {
                category: 'custom',
                event: 'legacy_access_mapping_saved',
                connectionId: row.id,
                version: mapping.version,
                previousVersion: current?.version ?? null,
                columnSetFingerprint: mapping.columnSetFingerprint,
                // COLUMN NAMES, which are schema metadata an administrator typed and
                // the mapping UI already displays. No cell value appears here, and
                // none can: this function never reads a row.
                fields: { ...mapping.fields },
                entitlementLayout: mapping.entitlements.kind,
                projection: projectedColumns(mapping),
                // The DIFF, not just the new state. "What changed?" is the
                // question an auditor asks, and answering it with two
                // seventeen-key objects leaves them doing the comparison by eye.
                diff: diffMappings(current, mapping) as unknown as Record<string, unknown>,
                confirmedByUserId: mapping.confirmedByUserId,
            },
        });

        return mapping;
    });
}

/**
 * Whether two mappings say the same thing.
 *
 * Compares what the mapping MEANS — the projection, the field assignments, the
 * layout, the status folds and the fingerprint — and deliberately ignores
 * `version`, `confirmedAt` and `confirmedByUserId`, which differ on every save by
 * construction. Comparing the whole object would make every re-save a change.
 */
function sameMapping(a: StoredMapping, b: StoredMapping): boolean {
    if (a.columnSetFingerprint !== b.columnSetFingerprint) return false;
    if (JSON.stringify(a.entitlements) !== JSON.stringify(b.entitlements)) return false;
    const norm = (m: Readonly<Record<string, unknown>> | undefined): string =>
        JSON.stringify(Object.entries(m ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    if (norm(a.fields) !== norm(b.fields)) return false;
    if (norm(a.statusValues) !== norm(b.statusValues)) return false;
    return true;
}

// ─── The audited diff ──────────────────────────────────────────────────────

export interface MappingFieldChange {
    readonly from: string;
    readonly to: string;
}

export interface MappingDiff {
    /** canonical field → column, for fields the new version maps and the old did not. */
    readonly fieldsAdded: Readonly<Record<string, string>>;
    /** canonical field → the column the OLD version mapped, for fields now unmapped. */
    readonly fieldsRemoved: Readonly<Record<string, string>>;
    /** canonical field → { from, to }, for fields that moved to a different column. */
    readonly fieldsChanged: Readonly<Record<string, MappingFieldChange>>;
    readonly layoutChanged: MappingFieldChange | null;
    /** Status folds, as a count of changed keys. The keys are the SOURCE values. */
    readonly statusValueKeysChanged: readonly string[];
    readonly fingerprintChanged: MappingFieldChange | null;
}

/**
 * What changed between two mapping versions.
 *
 * Audited because "why did this account get suggested to that person last month?"
 * is answerable only if the mapping in force at the time is recoverable, and a
 * bare before/after of the whole object is not an answer — somebody comparing two
 * seventeen-key objects in an audit viewer is doing the diff by eye, which is the
 * work this is supposed to have done for them.
 *
 * Column NAMES and status SOURCE VALUES appear here, and both are safe: a column
 * name is schema metadata the mapping screen already shows, and a status source
 * value reached that screen only by passing `mayExposeValueSet` — it is a
 * vocabulary member like `A` or `LOCKD`, which describes many rows rather than a
 * person. No cell value can appear, because this function never sees a row.
 */
export function diffMappings(
    previous: StoredMapping | null,
    next: StoredMapping
): MappingDiff {
    const before = previous?.fields ?? {};
    const after = next.fields;

    const fieldsAdded: Record<string, string> = {};
    const fieldsRemoved: Record<string, string> = {};
    const fieldsChanged: Record<string, MappingFieldChange> = {};

    for (const [field, column] of Object.entries(after)) {
        if (typeof column !== 'string') continue;
        const old = (before as Record<string, string | undefined>)[field];
        if (old === undefined) fieldsAdded[field] = column;
        else if (old !== column) fieldsChanged[field] = { from: old, to: column };
    }
    for (const [field, column] of Object.entries(before)) {
        if (typeof column !== 'string') continue;
        if ((after as Record<string, string | undefined>)[field] === undefined) {
            fieldsRemoved[field] = column;
        }
    }

    const layoutBefore = previous ? describeLayout(previous.entitlements) : null;
    const layoutAfter = describeLayout(next.entitlements);
    const layoutChanged =
        layoutBefore !== null && layoutBefore !== layoutAfter
            ? { from: layoutBefore, to: layoutAfter }
            : null;

    // The union of both key sets, so a REMOVED fold is reported as loudly as an
    // added one. Dropping a fold silently re-routes a status to UNKNOWN, which is
    // the fail-closed direction but still a change somebody made.
    const foldsBefore = previous?.statusValues ?? {};
    const foldsAfter = next.statusValues ?? {};
    const statusValueKeysChanged = [
        ...new Set([...Object.keys(foldsBefore), ...Object.keys(foldsAfter)]),
    ]
        .filter((k) => (foldsBefore as Record<string, string | undefined>)[k]
            !== (foldsAfter as Record<string, string | undefined>)[k])
        .sort();

    const fingerprintChanged =
        previous && previous.columnSetFingerprint !== next.columnSetFingerprint
            ? { from: previous.columnSetFingerprint, to: next.columnSetFingerprint }
            : null;

    return {
        fieldsAdded,
        fieldsRemoved,
        fieldsChanged,
        layoutChanged,
        statusValueKeysChanged,
        fingerprintChanged,
    };
}

/** A layout as one short string, so a diff of two layouts reads as a diff. */
function describeLayout(layout: StoredMapping['entitlements']): string {
    switch (layout.kind) {
        case 'none':
            return 'none';
        case 'wide':
            return `wide(${[...layout.columns].sort().join(',')})`;
        case 'long':
            return `long(${layout.column})`;
        case 'delimited':
            return `delimited(${layout.column} on "${layout.delimiter}")`;
    }
}
