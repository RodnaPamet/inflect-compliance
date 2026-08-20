/**
 * Email notification service barrel exports.
 */
export { enqueueEmail, buildDedupeKey, type EnqueueEmailInput } from './enqueue';
export { processOutbox, type ProcessOutboxOptions, type ProcessOutboxResult } from './processOutbox';
export {
    getTenantNotificationSettings,
    updateTenantNotificationSettings,
    isNotificationsEnabled,
    getOutboxStats,
    type TenantNotificationSettingsData,
    type OutboxStats,
} from './settings';
export {
    buildTaskAssignedEmail,
    buildEvidenceExpiringEmail,
    buildPolicyApprovalRequestedEmail,
    buildPolicyDecisionEmail,
    type EmailTemplateResult,
    type TaskAssignedPayload,
    type EvidenceExpiringPayload,
    type PolicyApprovalRequestedPayload,
    type PolicyDecisionPayload,
} from './templates';
export {
    buildDeadlineDigestEmail,
    buildEvidenceExpiryDigestEmail,
    buildVendorRenewalDigestEmail,
    type DeadlineDigestPayload,
    type EvidenceExpiryDigestPayload,
    type VendorRenewalDigestPayload,
} from './digest-templates';
export {
    dispatchDigest,
    buildDigestDedupeKey,
    type DigestCategory,
    type DispatchDigestOptions,
    type DispatchDigestResult,
} from './digest-dispatcher';
export {
    buildIdentityLeaverDisabledEmail,
    buildIdentityLeaverUnconfirmedEmail,
    buildIdentityLeaverNeedsActionEmail,
    type LeaverAudience,
    type IdentityLeaverDisabledPayload,
    type IdentityLeaverUnconfirmedPayload,
    type IdentityLeaverNeedsActionPayload,
} from './leaver-templates';
export {
    buildLeaverAudienceBook,
    notifyLeaverOutcome,
    planLeaverNotifications,
    type LeaverAudienceBook,
    type LeaverNotificationPlan,
    type LeaverRecipient,
    type LeaverSubject,
    type NotifyLeaverInput,
    type NotifyLeaverResult,
} from './leaver';
