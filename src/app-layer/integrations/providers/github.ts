/**
 * Compatibility re-export — github.ts → github/index.ts
 *
 * This file ensures the old import path `./providers/github` still works.
 * It re-exports everything from the new folder barrel.
 * New code should import from './providers/github' (which resolves here anyway).
 *
 * NOTE: Node module resolution prefers this file over github/index.ts.
 * Therefore ALL exports must be forwarded here.
 */
export {
    // New pattern
    GitHubClient,
    type GitHubConnectionConfig,
    GitHubBranchProtectionMapper,
    GitHubSyncOrchestrator,

    // Legacy provider
    GitHubProvider,
    fetchBranchProtection,
    fetchBranchRules,
    evaluateBranchProtection,
    type GitHubBranchProtection,
    type GitHubBranchRule,
} from './github/index';

export type { FetchFn } from './github/legacy-provider';
