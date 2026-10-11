/**
 * azure-posture → IC control mapping (ORIGINAL — foundation subset, PR-3).
 *
 * Maps a Powerpipe (steampipe-mod-azure-compliance, Apache-2.0) benchmark
 * control id to the IC framework requirement code(s) it evidences. ORIGINALLY
 * authored against IC's OWN library codes (SOC 2 CCx.y + NIST CSF 2.0
 * subcategories) — no mod HCL/SQL or embedded mappings transcribed. Resolves
 * against installed frameworks with no dangling refs.
 */
import type { CloudPostureControlMapEntry } from '@/app-layer/integrations/cloud-posture/powerpipe-core';

export const AZURE_POSTURE_CONTROL_MAP: Record<string, CloudPostureControlMapEntry> = {
    // ── Identity & access (CC6 / PR.AA) ──
    iam_no_custom_subscription_owner_roles_created: { label: 'No custom subscription owner roles', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
    iam_subscription_owner_max_3: { label: 'At most 3 subscription owners', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
    keyvault_purge_protection_enabled: { label: 'Key Vault purge protection', soc2: ['CC6.1'], nistCsf: ['PR.DS-01'] },
    // `mfa_enabled_for_privileged_users` named no real control. The mod has no
    // single "privileged users" control — it scopes MFA by subscription
    // permission level, so the one row becomes the two levels that ARE
    // privileged. `iam_user_with_read_permission_on_subscription_mfa_enabled`
    // is deliberately NOT mapped: read access is not privileged access.
    // ...and the per-permission-level ones (`iam_user_with_{owner,write}_permission_
    // on_subscription_mfa_enabled`) exist as controls but appear ONLY under the
    // HIPAA / NIST / PCI benchmarks, never under `all_controls`, which is what we
    // run. A mapped id the run never emits is a dead row, so this maps the
    // privileged-scoped MFA control that IS in `all_controls`.
    ad_admin_portals_require_mfa: { label: 'MFA required for admin portals', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
    // ── Data protection (CC6 / PR.DS) ──
    storage_account_secure_transfer_required_enabled: { label: 'Storage secure transfer required', soc2: ['CC6.1'], nistCsf: ['PR.DS-01'] },
    storage_account_blob_public_access_disabled: { label: 'Blob public access disabled', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
    sql_server_transparent_data_encryption_enabled: { label: 'SQL TDE enabled', soc2: ['CC6.1'], nistCsf: ['PR.DS-01'] },
    // ── Monitoring & detection (CC7 / DE.CM) ──
    sql_server_azure_defender_enabled: { label: 'Defender for SQL enabled', soc2: ['CC7.1'], nistCsf: ['DE.CM-01'] },
    monitor_diagnostic_settings_captures_proper_categories: { label: 'Activity log captured', soc2: ['CC7.1'], nistCsf: ['DE.CM-01'] },
    network_watcher_enabled: { label: 'Network Watcher enabled', soc2: ['CC7.1'], nistCsf: ['DE.CM-01'] },
    // ── Network (CC6 / PR.AA) ──
    network_security_group_ssh_access_restricted: { label: 'SSH not open to the internet', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
    network_security_group_rdp_access_restricted: { label: 'RDP not open to the internet', soc2: ['CC6.1'], nistCsf: ['PR.AA-01'] },
};

/** All SOC 2 / NIST CSF codes referenced — used by the map-validity test. */
export function allMappedRequirementCodes(): { soc2: string[]; nistCsf: string[] } {
    const soc2 = new Set<string>();
    const nistCsf = new Set<string>();
    for (const e of Object.values(AZURE_POSTURE_CONTROL_MAP)) {
        e.soc2.forEach((c) => soc2.add(c));
        e.nistCsf?.forEach((c) => nistCsf.add(c));
    }
    return { soc2: [...soc2], nistCsf: [...nistCsf] };
}
