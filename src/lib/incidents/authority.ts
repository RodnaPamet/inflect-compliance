/**
 * The NIS2 Article 23 notification authority a workspace names
 * (`TenantSecuritySettings.incidentAuthority`): free text such as
 * "CCB (Belgium)" or "BSI (Germany)", shown on every incident as the
 * authority to notify.
 *
 * Pure and client-safe, so the settings card's `maxLength` and the server's
 * refusal read the same number.
 */

/** The longest authority name accepted, after trimming. */
export const MAX_INCIDENT_AUTHORITY_LENGTH = 200;

/**
 * The anchor of the field on the security settings page, which the incident
 * page links to.
 */
export const INCIDENT_AUTHORITY_ANCHOR = 'incident-authority';
