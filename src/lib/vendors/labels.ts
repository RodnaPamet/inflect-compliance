/**
 * Vendor status and criticality labels, keyed on the stored enum values and
 * resolved through the `vendors` message namespace (`t =
 * useTranslations('vendors')`).
 *
 * Shared, not route-local: the vendor list's filter and the Information
 * Registry (#4639) both show these values, and they must read the same on
 * both pages. Keys follow `VendorStatus` / `VendorCriticality` exactly — the
 * register's filter once offered a SUSPENDED status the enum does not have.
 */
type T = (key: string) => string;

export function vendorStatusLabels(t: T): Record<string, string> {
    return {
        ONBOARDING: t('filterEnums.status.onboarding'),
        ACTIVE: t('filterEnums.status.active'),
        OFFBOARDING: t('filterEnums.status.offboarding'),
        OFFBOARDED: t('filterEnums.status.offboarded'),
    };
}

export function vendorCriticalityLabels(t: T): Record<string, string> {
    return {
        LOW: t('filterEnums.criticality.low'),
        MEDIUM: t('filterEnums.criticality.medium'),
        HIGH: t('filterEnums.criticality.high'),
        CRITICAL: t('filterEnums.criticality.critical'),
    };
}
