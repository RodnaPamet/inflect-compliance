/**
 * GitHub Integration — Provider Module Index
 *
 * Single entry point for the GitHub integration bundle.
 * Re-exports all components needed by the registry and consuming code.
 *
 * File layout:
 *   providers/github/
 *     ├── index.ts           ← this file (barrel export)
 *     ├── client.ts          ← GitHubClient (BaseIntegrationClient)
 *     ├── mapper.ts          ← GitHubBranchProtectionMapper (BaseFieldMapper)
 *     ├── sync.ts            ← GitHubSyncOrchestrator (BaseSyncOrchestrator)
 *     └── legacy-provider.ts ← GitHubProvider (ScheduledCheckProvider + WebhookEventProvider)
 *
 * @module integrations/providers/github
 */

// New pattern — client + mapper + orchestrator
export { GitHubClient, type GitHubConnectionConfig } from './client';
export { GitHubBranchProtectionMapper } from './mapper';
export { GitHubSyncOrchestrator } from './sync';

// Legacy provider — still used by ProviderRegistry for automationKey routing
export { GitHubProvider } from './legacy-provider';
export { fetchBranchProtection, fetchBranchRules, evaluateBranchProtection } from './legacy-provider';
export type { GitHubBranchProtection, GitHubBranchRule } from './legacy-provider';
