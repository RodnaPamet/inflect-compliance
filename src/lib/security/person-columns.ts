/**
 * Person columns: the schema columns that hold a person's name, address or
 * login, in any form (#5950, owner decision 2026-11-25).
 *
 * ═══ WHAT READS IT ═══
 *
 * The Prisma audit extension (`buildDiffJson` in `src/lib/prisma.ts`) writes a
 * row for every `update` / `upsert` in a tenant context, and records the VALUES
 * of the changed columns in `detailsJson.after` / `detailsJson.before` (and the
 * same in `diffJson`). For a column listed here it records the NAME of the field
 * in `changedFields` and in `withheldFields`, and no value — the way it already
 * names an Epic B encrypted field without recording it.
 *
 * Why: an audit row is immutable and hash-chained, so a DSAR erasure can null
 * `userId` and nothing else, and `detailsJson` streams to the tenant's SIEM
 * (Epic C.4), whose contract is an opaque id. A value written there is a value
 * nobody can take back. The record the row is about (`entityId`) still names
 * who, while the record exists.
 *
 * "In any form" is deliberate. A ciphertext column (`emailEncrypted`) and a
 * keyed lookup hash (`emailHash`) are listed beside the plaintext one: the
 * prior row is read through the decrypting client, so a PII column `@map`'d to
 * its ciphertext reaches `before` as PLAINTEXT, and a lookup hash is the
 * address in another spelling for whoever holds the deployment key.
 *
 * ═══ WHAT HOLDS IT ═══
 *
 * `tests/guardrails/audit-person-columns-classified.test.ts` fails while any
 * schema column whose name looks like an e-mail or a name (`/mail|name/i`, on a
 * `String` or `Json` column) is in neither {@link PERSON_COLUMNS} nor
 * {@link NOT_PERSON_COLUMNS}, and while either list names a column the schema
 * does not have. A new column is a decision, not a default: list it here, or
 * list it below with the reason it names no person.
 */

export const PERSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    // ─── Accounts (PII middleware: `@map`'d to ciphertext, decrypted on read) ───
    User: ['email', 'emailHash', 'name'],
    AuditorAccount: ['email', 'emailHash', 'name'],
    UserIdentityLink: ['emailAtLinkTime', 'emailAtLinkTimeHash'],

    // ─── Invitations: the invitee, before any account exists ───
    TenantInvite: ['email'],
    OrgInvite: ['email'],

    // ─── Outbound mail: the recipient ───
    NotificationOutbox: ['toEmail', 'toEmailEncrypted'],

    // ─── Directory and HR rosters ───
    // Written on every identity / HRIS sync upsert, which is why this list
    // exists at all: each sync used to put the before and after of a person's
    // name and address into the trail.
    ConnectedIdentityAccount: [
        'email',
        'displayName',
        'mailNickname',
        'samAccountName',
        'userPrincipalName',
    ],
    Employee: [
        'fullName',
        'givenName',
        'familyName',
        'middleName',
        'preferredName',
        'legalName',
        'workEmail',
    ],
    PreHire: ['fullName'],
    // A legacy application's own account table. `username` is a login, often
    // built from the person's name (`jsmith`), so it is a person column here;
    // `accountKey`, the row's identifier in that application, is not listed,
    // as part 1 classified it.
    LegacyAccount: ['username', 'displayName', 'givenName', 'familyName', 'email'],

    // ─── People outside the tenant ───
    TrustCenterAccessRequest: ['requesterName', 'requesterEmail'],
    // Legacy dual-write PII: the plaintext column, its ciphertext twin and the
    // lookup hash. `phone` is not name- or e-mail-shaped and the guard does not
    // ask about it; it is listed because it is the same person's contact detail.
    VendorContact: [
        'name',
        'nameEncrypted',
        'email',
        'emailEncrypted',
        'emailHash',
        'phone',
        'phoneEncrypted',
    ],
    VendorAssessment: ['respondentEmail'],
} as const;

/**
 * Columns whose name looks like an e-mail or a name and which hold no person's,
 * each with the reason. Their values stay in the audit diff.
 *
 * Keyed `Model.field`. The reason is for the reviewer: say what the column
 * names, not that it is "fine".
 */
export const NOT_PERSON_COLUMNS: Readonly<Record<string, string>> = {
    // ─── Workspace configuration (owner decision 2, 2026-11-25) ───
    'TenantNotificationSettings.defaultFromName':
        'The workspace sender identity: configuration, like an organisation name. Who changed it to what is the question its audit row answers.',
    'TenantNotificationSettings.defaultFromEmail':
        'The workspace sender address: configuration, like an organisation name. Who changed it to what is the question its audit row answers.',
    'TenantNotificationSettings.complianceMailbox':
        'The workspace compliance mailbox: configuration. Who redirected it to what is the forensic question its audit row answers.',
    'TenantIdentityProvider.emailDomains':
        'The e-mail domains an identity provider serves: domains, not addresses.',

    // ─── Organisations and workspaces ───
    'Tenant.name': 'A workspace name.',
    'Organization.name': 'An organisation name.',
    'Vendor.name': 'A vendor organisation name.',
    'Vendor.legalName': 'A vendor organisation legal name.',
    'TrustCenter.displayName': "The workspace's public trust-center name.",

    // ─── Groups and directory objects that are not people ───
    'ScimGroup.displayName': 'A directory group name.',
    'TenantEntraGroupMapping.aadGroupName': 'An Entra group name.',
    'IdentityDepartmentGroupRule.groupName': 'A directory group name.',
    'TenantSecuritySettings.identityDefaultGroupName': 'A directory group name.',
    'DiscoveredThirdPartyApp.displayName': 'A third-party application name.',
    'Device.hostname': 'A device host name.',

    // ─── Agents, tools and models ───
    'RegisteredAgent.name': 'An agent name.',
    'PeerAgent.name': "A peer organisation's agent name.",
    'HostConsumer.name': 'An A2A host consumer (an application) name.',
    'AgentHarnessEstate.name': 'A client estate name.',
    'AgentAssessmentDomain.name': 'An assessment domain name.',
    'TenantSkill.name': 'A skill name.',
    'WorkflowStep.subagentName': "A profile's sub-agent name.",
    'RegisteredAgentTool.toolName': 'A tool name.',
    'McpToolManifestPin.toolName': 'A tool name.',
    'ExternalToolParameterSet.toolName': 'A tool name.',
    'AgentBehaviourWindow.toolNames': 'Tool names.',
    'AgentProfileVersion.toolNames': 'Tool names.',
    'AgentProfileVersion.deferredToolNames': 'Tool names.',
    'AccessReviewAgentNarrowing.toolName': 'A tool name.',
    'AgentActionReceipt.toolName': 'A tool name.',
    'ExternalWriteJournal.connectionName': 'An integration connection name.',
    'ExternalWriteJournal.toolName': 'A tool name.',
    'ExternalWriteJournal.advertisedToolName': 'A tool name.',
    'ExternalToolPriorStateRead.writeToolName': 'A tool name.',
    'ExternalToolPriorStateRead.readToolName': 'A tool name.',
    'OpenShellSandboxLease.providerName': 'A sandbox provider name.',
    'RiskSuggestionSession.modelName': 'A model name.',
    'VendorDocExtraction.modelName': 'A model name.',

    // ─── Credentials and connections ───
    'TenantApiKey.name': 'An API key label.',
    'TenantDeviceToken.name': 'A device token label.',
    'TenantIdentityProvider.name': 'An identity provider label.',
    'IntegrationConnection.name': 'An integration connection label.',
    'TenantCustomRole.name': 'A custom role name.',

    // ─── Compliance records ───
    'AiGovDomain.name': 'An assessment domain name.',
    'AiSystem.name': 'An AI system name.',
    'Asset.name': 'An asset name.',
    'AuditCycle.name': 'An audit cycle name.',
    'AuditPack.name': 'An audit pack name.',
    'AccessReview.name': 'A campaign name.',
    'AutomationRule.name': 'An automation rule name.',
    'Control.name': 'A control name.',
    'ControlTestPlan.name': 'A test plan name.',
    'Framework.name': 'A framework name.',
    'FrameworkPack.name': 'A framework pack name.',
    'RequirementMappingSet.name': 'A mapping set name.',
    'BusinessImpactAnalysis.name': 'An analysis name.',
    'TrainingCourse.name': 'A course name.',
    'ProcessMap.name': 'A process map name.',
    'InboundQuestionnaire.name': 'A questionnaire name.',
    'RiskScenario.name': 'A risk scenario name.',
    'RiskHierarchyNode.name': 'A risk hierarchy node name.',
    'KeyRiskIndicator.name': 'An indicator name.',
    'ReportTemplate.name': 'A report template name.',
    'QuestionnaireTemplate.name': 'A questionnaire template name.',
    'VendorAssessmentTemplate.name': 'An assessment template name.',
    'VendorEvidenceBundle.name': 'An evidence bundle name.',
    'Nis2GapDomain.name': 'A NIS2 gap domain name (localised JSON).',

    // ─── Files ───
    'Evidence.fileName': 'An uploaded file name.',
    'FileRecord.originalName': 'An uploaded file name.',
};

/** The person columns of one model, as a set; empty for a model with none. */
export function personColumnsOf(model: string | undefined): ReadonlySet<string> {
    return new Set(model ? PERSON_COLUMNS[model] ?? [] : []);
}
