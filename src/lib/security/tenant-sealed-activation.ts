/**
 * The brake for sealing `TENANT_SEALED_COLUMNS` under the workspace's own key
 * (#5969, #5942 phase 2).
 *
 * `false`: `sealTenantSecret` still writes a `v1:` envelope under the master
 * key, exactly as the column was written before. `openTenantSecret` reads both
 * forms whatever this says.
 *
 * It ships `false` first, ahead of the commit that sets it `true`, because code
 * from before the readers learned `v2:` cannot read a `v2:` secret: rolling a
 * `true` build back to such code would make every credential written since
 * unreadable. Setting it back to `false` is the rollback once the readers are
 * deployed, and it strands nothing, because the readers keep reading `v2:`.
 *
 * A leaf module that imports nothing, so a test can replace the value with a
 * `jest.mock` getter.
 */
export const TENANT_SEALED_UNDER_TENANT_KEY = false;
