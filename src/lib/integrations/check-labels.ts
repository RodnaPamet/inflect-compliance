/**
 * The integration check ids the admin catalogue carries a label for, under
 * `admin.integrations.checkLabels.<id>` in both message catalogues.
 *
 * Providers declare their checks as machine ids (`mfa_enforced`), and the
 * Integrations page printed them as-is on every catalogue card and in the
 * connection form (#4466). A check with no entry here still renders, as its id,
 * rather than as a missing-message key.
 *
 * A local set rather than a `t.has()` probe, for the two reasons
 * `entity-prev-next-nav.tsx` records: most hand-rolled `next-intl` mocks in the
 * rendered suites implement only `t`, and `t.has` asks the CURRENT locale, so a
 * label missing in bg would degrade silently. `tests/unit/integrations/
 * check-labels.test.ts` pins this set against both catalogues and against every
 * registered provider's `supportedChecks`, so a new check fails the build until
 * it is labelled.
 */
export const LABELLED_CHECKS: ReadonlySet<string> = new Set([
    // Identity directories (Okta, Google Workspace, Entra ID, Active Directory).
    'mfa_enforced',
    'no_dormant_admins',
    'admin_count_within_threshold',
    'sso_enforced',
    // Training & background.
    'training_completed_annually',
    'background_check_complete',
    // ServiceNow.
    'change_approved_before_implementation',
    // Device posture.
    'devices_encrypted',
    'devices_screenlock',
    'devices_antivirus',
    'devices_password_manager',
    // Personnel.
    'offboarded_access_removed',
    'onboarding_complete_within_sla',
    'every_employee_has_manager',
    // Cloud posture benchmarks (AWS, Azure, GCP).
    'soc2',
    'cis',
    // GitHub.
    'branch_protection',
]);
