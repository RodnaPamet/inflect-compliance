/**
 * The ONE way to write and read a column in `TENANT_SEALED_COLUMNS` (#5969).
 *
 * These columns are sealed by the code that writes them rather than by the
 * encryption extension, because their values are assembled and read back by
 * dozens of call sites that need the plaintext in hand (every integration's
 * credentials, read at every sync, call and connection test). What the
 * extension would have given them, these two functions give them explicitly:
 *
 * - `sealTenantSecret` writes a `v2:` envelope under the workspace's own key.
 *   While `TENANT_SEALED_UNDER_TENANT_KEY` is `false` it writes `v1:` under the
 *   master key instead, as the column was written before.
 * - `openTenantSecret` reads both: `v2:` under the workspace key, falling back
 *   to its previous key while a per-workspace rotation is in flight, and
 *   anything else through `decryptField`, which reads `v1:` under the master
 *   key (and its previous key during a master-key rotation) and refuses the
 *   rest exactly as before.
 *
 * Both rotations reach these columns: the per-workspace key rotation rewrites
 * every `v2:` value (`jobs/tenant-dek-rotation.ts`), and the master-key
 * rotation re-seals every `v1:` value through `sealTenantSecret`
 * (`jobs/key-rotation.ts`), which moves it to `v2:` once the brake is off.
 *
 * The `tenantId` must be the ROW's workspace. A `v2:` value opened with another
 * workspace's key fails authentication; it never decrypts to the wrong thing.
 *
 * `tests/guards/tenant-sealed-columns.test.ts` holds every read and write of
 * these columns to this module.
 */
import {
    decryptField,
    decryptWithKeyOrPrevious,
    encryptField,
    encryptWithKey,
} from '@/lib/security/encryption';
import { getTenantDek, getTenantPreviousDek } from '@/lib/security/tenant-key-manager';
import { TENANT_SEALED_UNDER_TENANT_KEY } from '@/lib/security/tenant-sealed-activation';

const TENANT_KEY_PREFIX = 'v2:';

/** Seal a value for a `TENANT_SEALED_COLUMNS` column of `tenantId`'s row. */
export async function sealTenantSecret(tenantId: string, plaintext: string): Promise<string> {
    if (!TENANT_SEALED_UNDER_TENANT_KEY) return encryptField(plaintext);
    if (!tenantId) throw new Error('sealTenantSecret: a tenantId is required');
    return encryptWithKey(await getTenantDek(tenantId), plaintext);
}

/** Open a value read from a `TENANT_SEALED_COLUMNS` column of `tenantId`'s row. */
export async function openTenantSecret(tenantId: string, ciphertext: string): Promise<string> {
    if (typeof ciphertext === 'string' && ciphertext.startsWith(TENANT_KEY_PREFIX)) {
        if (!tenantId) throw new Error('openTenantSecret: a tenantId is required for a v2: value');
        const [primary, previous] = await Promise.all([
            getTenantDek(tenantId),
            getTenantPreviousDek(tenantId),
        ]);
        return decryptWithKeyOrPrevious(primary, previous, ciphertext);
    }
    return decryptField(ciphertext);
}
