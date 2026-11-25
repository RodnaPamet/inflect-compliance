/**
 * The brake for sealing `TENANT_SEALED_COLUMNS` under the workspace's own key
 * (#5969, #5942 phase 2).
 *
 * `true` (since deploy 2 of #5969): `sealTenantSecret` writes a `v2:` envelope
 * under the workspace's DEK, and a master-key rotation of a workspace moves
 * its remaining `v1:` values onto that key. `openTenantSecret` reads both
 * forms whatever this says.
 *
 * Setting it back to `false` is the rollback: new writes go back under the
 * master key, and nothing already written is stranded, because the readers
 * shipped in deploy 1 keep reading `v2:`. Do not roll back past deploy 1
 * (`v3.434.0`) while any `v2:` secret exists: older code cannot read one.
 *
 * A leaf module that imports nothing, so a test can replace the value with a
 * `jest.mock` getter.
 */
export const TENANT_SEALED_UNDER_TENANT_KEY = true;
