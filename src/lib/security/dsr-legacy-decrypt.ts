/**
 * Decrypt DataSubjectRequest values written while the model was in the
 * field-encryption manifest — #5107.
 *
 * The model left the manifest (owner decision, 2026-11-13): it has no
 * `tenantId`, the middleware encrypted under the ACTING request's tenant DEK,
 * and the tenant-DEK rotation sweep skipped it. Values written while it was
 * listed are still ciphertext, and with the model out of the manifest nothing
 * decrypts them on read. This turns each one back into plaintext.
 *
 *   `v1:`  the global key (with its previous-key fallback), `decryptField`
 *   `v2:`  a tenant DEK, current or previous. The row does not say which
 *          tenant, so the candidates are the workspaces of the person who
 *          handled the request (whose session wrote it) and of its subject.
 *
 * A value no candidate key opens is LEFT AS IT IS and counted: it is not
 * erased, because a record of a data-subject request is evidence, and a
 * ciphertext an operator can still recover is better than a hole.
 *
 * Idempotent: a plaintext value is skipped, so the container start can run it
 * every time. The caller supplies an RLS-bypassing client.
 */
import type { PrismaClient } from '@prisma/client';
import { decryptField, decryptWithKeyOrPrevious, getCiphertextVersion } from './encryption';
import { getTenantDek, getTenantPreviousDek } from './tenant-key-manager';

const COLUMNS = ['rejectionReason', 'fulfilmentNotes'] as const;
type Column = (typeof COLUMNS)[number];

export interface DsrLegacyDecryptResult {
    readonly scanned: number;
    readonly decrypted: number;
    readonly undecryptable: number;
}

async function decryptV2(value: string, tenantIds: readonly string[]): Promise<string | null> {
    for (const tenantId of tenantIds) {
        try {
            const primary = await getTenantDek(tenantId);
            const previous = await getTenantPreviousDek(tenantId);
            return decryptWithKeyOrPrevious(primary, previous, value);
        } catch {
            // Not this tenant's key (or the tenant is gone): try the next.
        }
    }
    return null;
}

export async function decryptLegacyDsrFields(db: PrismaClient): Promise<DsrLegacyDecryptResult> {
    let scanned = 0;
    let decrypted = 0;
    let undecryptable = 0;

    // Read the STORED values with SQL, not through the client: the encryption
    // middleware decrypts any field whose NAME is in the manifest on any model
    // (`ControlException` has a `rejectionReason`), so the client would hand
    // back plaintext for a value that is still ciphertext in the table.
    const rows = await db.$queryRaw<
        { id: string; userId: string; handledById: string | null; rejectionReason: string | null; fulfilmentNotes: string | null }[]
    >`
        SELECT "id", "userId", "handledById", "rejectionReason", "fulfilmentNotes"
        FROM "DataSubjectRequest"
        WHERE "rejectionReason" LIKE 'v1:%' OR "rejectionReason" LIKE 'v2:%'
           OR "fulfilmentNotes" LIKE 'v1:%' OR "fulfilmentNotes" LIKE 'v2:%'
        ORDER BY "id"`;

    for (const row of rows) {
        scanned += 1;
        const people = [row.handledById, row.userId].filter((v): v is string => !!v);
        const memberships = await db.tenantMembership.findMany({
            where: { userId: { in: people } },
            select: { tenantId: true, userId: true },
            take: 200,
        });
        // The handler's workspaces first: their session wrote the note.
        const tenantIds = [
            ...memberships.filter((m) => m.userId === row.handledById).map((m) => m.tenantId),
            ...memberships.filter((m) => m.userId !== row.handledById).map((m) => m.tenantId),
        ].filter((id, i, all) => all.indexOf(id) === i);

        const plain: Partial<Record<Column, string>> = {};
        for (const column of COLUMNS) {
            const value = row[column];
            const version = getCiphertextVersion(value);
            if (!value || version === null) continue;
            let out: string | null = null;
            if (version === 'v1') {
                try {
                    out = decryptField(value);
                } catch {
                    out = null;
                }
            } else {
                out = await decryptV2(value, tenantIds);
            }
            if (out === null) {
                undecryptable += 1;
                continue;
            }
            plain[column] = out;
        }
        // Written with SQL for the same reason as the read: nothing between this
        // and the column should transform the value.
        if (plain.rejectionReason !== undefined) {
            await db.$executeRaw`UPDATE "DataSubjectRequest" SET "rejectionReason" = ${plain.rejectionReason} WHERE "id" = ${row.id}`;
            decrypted += 1;
        }
        if (plain.fulfilmentNotes !== undefined) {
            await db.$executeRaw`UPDATE "DataSubjectRequest" SET "fulfilmentNotes" = ${plain.fulfilmentNotes} WHERE "id" = ${row.id}`;
            decrypted += 1;
        }
    }
    return { scanned, decrypted, undecryptable };
}
