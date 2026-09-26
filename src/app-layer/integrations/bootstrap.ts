/**
 * Integration Provider Bootstrap
 *
 * Registers all available integration providers with the global registries.
 * Import this module once at application startup to enable all providers.
 *
 * Two registries are populated:
 *   - `registry` (ProviderRegistry) — automation key routing for checks/webhooks
 *   - `integrationRegistry` (IntegrationRegistry) — client + mapper bundles for CRUD
 *
 * Usage:
 *   import '@/app-layer/integrations/bootstrap';
 *
 * @module integrations/bootstrap
 */
import { registry, integrationRegistry } from './registry';
import { GitHubProvider } from './providers/github';
import { AwsPostureProvider } from './aws-posture-provider';
import { OktaProvider } from './providers/okta';
import { GoogleWorkspaceProvider } from './providers/google-workspace';
import { EntraIdProvider } from './providers/entra-id';
import { ActiveDirectoryProvider } from './providers/active-directory';
import { AzurePostureProvider } from './providers/azure-posture-provider';
import { GcpPostureProvider } from './providers/gcp-posture-provider';
import { BambooHrProvider } from './providers/hris';
import { WorkdayProvider } from './providers/workday';
import { OrangeHrmProvider } from './providers/orangehrm';
import { PersonnelProvider } from './providers/personnel';
import { DeviceProvider } from './providers/device';
import { TrainingProvider } from './providers/training';
import { GitHubClient } from './providers/github-client';
import { GitHubBranchProtectionMapper } from './providers/github-mapper';
import { GitHubSyncOrchestrator } from './providers/github/sync';
import { SharePointClient } from './providers/sharepoint/client';
import { SharePointMapper } from './providers/sharepoint/mapper';
import { ServiceNowProvider } from './providers/servicenow';
import { McpServerProvider } from './providers/mcp-server-provider';
import { ServiceNowClient } from './providers/servicenow/client';
import { ServiceNowChangeMapper } from './providers/servicenow/mapper';

// ─── ProviderRegistry: Automation Key Routing ────────────────────────

// GitHub — branch protection, repo security
registry.register(new GitHubProvider());

// AWS cloud posture — Powerpipe steampipe-mod-aws-compliance benchmark evidence.
registry.register(new AwsPostureProvider());

// Okta — directory sync + identity posture checks (MFA, dormant admins, …).
registry.register(new OktaProvider());

// Google Workspace — directory sync + identity posture checks.
registry.register(new GoogleWorkspaceProvider());

// Microsoft Entra ID (Azure AD) — directory sync + identity posture checks.
// Also covers on-prem Active Directory identities synced via Azure AD Connect.
registry.register(new EntraIdProvider());

// Active Directory (on-prem) — direct-LDAPS directory sync + identity posture
// checks for estates whose AD is NOT synced to Entra via Azure AD Connect.
registry.register(new ActiveDirectoryProvider());

// Azure cloud posture — Powerpipe steampipe-mod-azure-compliance benchmark evidence.
registry.register(new AzurePostureProvider());

// GCP cloud posture — Powerpipe steampipe-mod-gcp-compliance benchmark evidence.
registry.register(new GcpPostureProvider());

// BambooHR — HRIS roster sync into the personnel hub.
registry.register(new BambooHrProvider());

// Workday — HRIS roster sync into the personnel hub (OAuth2 + paginated RaaS).
registry.register(new WorkdayProvider());

// OrangeHRM — HRIS roster connector (#2548)
// (#2548). Registered because the HRIS sync resolves providers through this
// registry, so an unregistered one cannot be exercised end to end. See
// providers/orangehrm for the full note, including why it is in HRIS_PROVIDERS
// and what that costs a tenant.
registry.register(new OrangeHrmProvider());

// Personnel — internal checks (offboarded access, onboarding SLA, manager coverage).
registry.register(new PersonnelProvider());

// Device — internal checks (encryption, screen lock, antivirus, password manager).
registry.register(new DeviceProvider());

// Training & Background — internal checks (annual training completion, background-check status).
registry.register(new TrainingProvider());

// ServiceNow — change-management checks (approval on production changes).
registry.register(new ServiceNowProvider());

// External MCP server — holds the address and credential of a system an AGENT
// may be granted tools on. `supportedChecks` is empty on purpose, so this adds
// nothing to automationKey routing; it is here because `upsertIntegrationConnection`
// and `testConnectionCredentials` both reject a provider the registry does not
// know, which made the admin screen the provider was written FOR unreachable.
registry.register(new McpServerProvider());

// Future providers:
// registry.register(new GitLabProvider());

// ─── IntegrationRegistry: Client + Mapper Bundles ────────────────────

integrationRegistry.register({
    name: 'github',
    type: 'scm',
    displayName: 'GitHub',
    description: 'GitHub repository compliance — branch protection, security settings',
    clientClass: GitHubClient,
    mapperClass: GitHubBranchProtectionMapper,
    orchestratorClass: GitHubSyncOrchestrator,
});

// SharePoint — document libraries: evidence import + policy sync (SP-1).
// No orchestratorClass yet — the sync orchestrator lands in SP-3.
integrationRegistry.register({
    name: 'sharepoint',
    type: 'document',
    displayName: 'Microsoft SharePoint',
    description: 'SharePoint document libraries — evidence import, policy sync, audit-pack export',
    clientClass: SharePointClient,
    mapperClass: SharePointMapper,
});

// ServiceNow — ITSM: change requests as change-management evidence (S1).
// No orchestratorClass yet — outbound writes land in S5, where retry
// idempotency is the design question rather than an afterthought.
integrationRegistry.register({
    name: 'servicenow',
    type: 'itsm',
    displayName: 'ServiceNow',
    description: 'ServiceNow change management — change requests, approvals, and implementation records as evidence',
    clientClass: ServiceNowClient,
    mapperClass: ServiceNowChangeMapper,
});

// Future bundles:
// integrationRegistry.register({ name: 'jira', type: 'itsm', ... });

