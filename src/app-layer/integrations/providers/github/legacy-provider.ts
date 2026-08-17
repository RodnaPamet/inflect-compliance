/**
 * GitHub Integration Provider
 *
 * Implements the ScheduledCheckProvider and WebhookEventProvider interfaces
 * for GitHub-backed compliance checks.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SUPPORTED CHECKS
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   github.branch_protection
 *     Verifies that a repository branch has protection rules enabled.
 *     Checks: protection enabled, required reviews, status checks required.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONNECTION CONFIG
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   configJson:
 *     owner:       GitHub org or user (e.g. "acme-corp")
 *     repo:        Repository name (e.g. "platform-api")
 *     branch:      Branch to check (default: "main")
 *
 *   secrets:
 *     token:         GitHub personal access token or app token
 *     webhookSecret: Webhook signing secret (optional)
 *
 * @module integrations/providers/github
 */
import type {
    ScheduledCheckProvider,
    WebhookEventProvider,
    CheckInput,
    CheckResult,
    EvidencePayload,
    ConnectionValidationResult,
    ConnectionConfigSchema,
    WebhookPayload,
    WebhookProcessResult,
} from '../../types';
import type { RequestContext } from '../../../types';
import { verifyGitHubSignature } from '../../webhook-crypto';
import { logger } from '@/lib/observability/logger';
import { boundedFetch } from '../../bounded-fetch';

// ─── GitHub API Types ────────────────────────────────────────────────

export interface GitHubBranchProtection {
    url: string;
    required_status_checks: {
        strict: boolean;
        contexts: string[];
    } | null;
    enforce_admins: { enabled: boolean } | null;
    required_pull_request_reviews: {
        required_approving_review_count: number;
        dismiss_stale_reviews: boolean;
        require_code_owner_reviews: boolean;
    } | null;
    restrictions: unknown;
    required_linear_history: { enabled: boolean } | null;
    allow_force_pushes: { enabled: boolean } | null;
    allow_deletions: { enabled: boolean } | null;
}

/**
 * Fetch function type for dependency injection (testability).
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ─── GitHub API Client ───────────────────────────────────────────────

/**
 * Fetch branch protection rules from GitHub API.
 * Supports dependency-injected fetch for testing.
 */
export async function fetchBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    token: string,
    fetchImpl: FetchFn = boundedFetch
): Promise<{ protection: GitHubBranchProtection | null; status: number; error?: string }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/branches/${branch}/protection`;

    try {
        const response = await fetchImpl(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });

        if (response.status === 200) {
            const data = await response.json() as GitHubBranchProtection;
            return { protection: data, status: 200 };
        }

        if (response.status === 404) {
            // 404 means branch protection is not enabled
            return { protection: null, status: 404 };
        }

        // Auth or other errors
        const errorBody = await response.text().catch(() => '');
        return {
            protection: null,
            status: response.status,
            error: `GitHub API error ${response.status}: ${errorBody.slice(0, 200)}`,
        };
    } catch (err) {
        return {
            protection: null,
            status: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

// ─── Check Logic ─────────────────────────────────────────────────────

/**
 * Evaluate branch protection rules and produce a check result.
 * This is a pure function — no I/O, fully testable.
 */
export function evaluateBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    protection: GitHubBranchProtection | null,
    apiStatus: number
): CheckResult {
    const repoRef = `${owner}/${repo}:${branch}`;

    // No protection at all
    if (!protection || apiStatus === 404) {
        return {
            status: 'FAILED',
            summary: `Branch protection is NOT enabled on ${repoRef}`,
            details: {
                repository: `${owner}/${repo}`,
                branch,
                protectionEnabled: false,
                requiredReviews: false,
                requiredStatusChecks: false,
                enforceAdmins: false,
                allowForcePushes: true,
            },
        };
    }

    // Evaluate individual rules
    const hasReviews = protection.required_pull_request_reviews !== null;
    const reviewCount = protection.required_pull_request_reviews?.required_approving_review_count ?? 0;
    const hasStatusChecks = protection.required_status_checks !== null;
    const enforceAdmins = protection.enforce_admins?.enabled ?? false;
    const allowForcePushes = protection.allow_force_pushes?.enabled ?? false;
    const dismissStaleReviews = protection.required_pull_request_reviews?.dismiss_stale_reviews ?? false;
    const requireCodeOwnerReviews = protection.required_pull_request_reviews?.require_code_owner_reviews ?? false;

    const checks = {
        protectionEnabled: true,
        requiredReviews: hasReviews && reviewCount >= 1,
        requiredStatusChecks: hasStatusChecks,
        enforceAdmins,
        allowForcePushes,
        dismissStaleReviews,
        requireCodeOwnerReviews,
        reviewCount,
    };

    // PASS if minimum security is met: reviews enabled + status checks required
    const passed = checks.requiredReviews && checks.requiredStatusChecks;

    const summaryParts: string[] = [];
    summaryParts.push(`Branch protection: enabled`);
    summaryParts.push(`Required reviews: ${hasReviews ? `${reviewCount} reviewer(s)` : 'NOT configured'}`);
    summaryParts.push(`Status checks: ${hasStatusChecks ? 'required' : 'NOT required'}`);
    summaryParts.push(`Enforce admins: ${enforceAdmins ? 'yes' : 'no'}`);
    summaryParts.push(`Force pushes: ${allowForcePushes ? 'ALLOWED' : 'blocked'}`);

    return {
        status: passed ? 'PASSED' : 'FAILED',
        summary: `${repoRef}: ${passed ? 'PASS' : 'FAIL'} — ${summaryParts.join('; ')}`,
        details: {
            repository: `${owner}/${repo}`,
            branch,
            ...checks,
        },
    };
}

// ─── Provider Implementation ─────────────────────────────────────────

export class GitHubProvider implements ScheduledCheckProvider, WebhookEventProvider {
    readonly id = 'github';
    /**
     * TRUE, and this was the mislabel worth fixing. `validateConnection` below
     * does a real authenticated `GET https://api.github.com/repos/{owner}/{repo}`
     * with the tenant's token — a revoked token or a wrong repo fails it. The
     * field was simply never declared, so the UI read the undefined as false
     * and told admins their verified connection was shape-only.
     */
    readonly liveValidation = true;
    readonly displayName = 'GitHub';
    readonly description = 'GitHub repository compliance checks — branch protection, security settings';
    readonly supportedChecks = ['branch_protection'];

    readonly configSchema: ConnectionConfigSchema = {
        configFields: [
            {
                key: 'owner',
                label: 'Repository Owner',
                type: 'string',
                required: true,
                placeholder: 'acme-corp',
                description: 'GitHub organization or user name',
            },
            {
                key: 'repo',
                label: 'Repository',
                type: 'string',
                required: true,
                placeholder: 'platform-api',
                description: 'Repository name to check',
            },
            {
                key: 'branch',
                label: 'Branch',
                type: 'string',
                required: false,
                placeholder: 'main',
                description: 'Branch to verify protection rules on (default: main)',
            },
        ],
        secretFields: [
            {
                key: 'token',
                label: 'Personal Access Token',
                type: 'string',
                required: true,
                placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
                description: 'GitHub PAT with repo scope',
            },
            {
                key: 'webhookSecret',
                label: 'Webhook Secret',
                type: 'string',
                required: false,
                placeholder: 'whsec_...',
                description: 'Optional: webhook signing secret for incoming events',
            },
        ],
    };

    /**
     * Injectable fetch for testing. Defaults to the BOUNDED fetch —
     * an injected impl bypasses the deadline, which is what makes the
     * timeout itself testable.
     */
    private fetchImpl: FetchFn;

    constructor(fetchImpl?: FetchFn) {
        this.fetchImpl = fetchImpl ?? boundedFetch;
    }

    // ── Connection Validation ──

    async validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>
    ): Promise<ConnectionValidationResult> {
        const owner = config.owner as string;
        const repo = config.repo as string;
        const token = secrets.token as string;

        if (!owner) return { valid: false, error: 'Repository owner is required' };
        if (!repo) return { valid: false, error: 'Repository name is required' };
        if (!token) return { valid: false, error: 'GitHub token is required' };

        // Test API access by fetching repo info
        try {
            const response = await this.fetchImpl(
                `https://api.github.com/repos/${owner}/${repo}`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/vnd.github.v3+json',
                    },
                }
            );
            if (response.status === 200) return { valid: true };
            if (response.status === 401) return { valid: false, error: 'Invalid or expired token' };
            if (response.status === 403) return { valid: false, error: 'Token lacks required permissions' };
            if (response.status === 404) return { valid: false, error: `Repository ${owner}/${repo} not found` };
            return { valid: false, error: `GitHub API returned status ${response.status}` };
        } catch (err) {
            return { valid: false, error: `Connection failed: ${err instanceof Error ? err.message : String(err)}` };
        }
    }

    // ── Scheduled Check ──

    async runCheck(input: CheckInput): Promise<CheckResult> {
        const { connectionConfig } = input;
        const owner = connectionConfig.owner as string;
        const repo = connectionConfig.repo as string;
        const branch = (connectionConfig.branch as string) || 'main';
        const token = connectionConfig.token as string;

        if (!owner || !repo || !token) {
            return {
                status: 'ERROR',
                summary: 'Missing required config: owner, repo, or token',
                details: { error: 'missing_config' },
                errorMessage: 'Missing required configuration fields',
            };
        }

        const startTime = Date.now();
        const { protection, status, error } = await fetchBranchProtection(
            owner, repo, branch, token, this.fetchImpl
        );

        if (error && status !== 404) {
            return {
                status: 'ERROR',
                summary: `GitHub API error: ${error}`,
                details: { apiStatus: status, error },
                errorMessage: error,
                durationMs: Date.now() - startTime,
            };
        }

        const result = evaluateBranchProtection(owner, repo, branch, protection, status);
        result.durationMs = Date.now() - startTime;
        return result;
    }

    // ── Evidence Mapping ──

    mapResultToEvidence(input: CheckInput, result: CheckResult): EvidencePayload | null {
        // Only create evidence for definitive results (not errors)
        if (result.status === 'ERROR') return null;

        const details = result.details as Record<string, unknown>;
        const repo = details.repository || 'unknown';
        const branch = details.branch || 'unknown';
        const statusEmoji = result.status === 'PASSED' ? '✅' : '❌';

        return {
            title: `${statusEmoji} GitHub Branch Protection: ${repo}:${branch}`,
            content: [
                `## Branch Protection Check — ${result.status}`,
                '',
                `**Repository:** ${repo}`,
                `**Branch:** ${branch}`,
                `**Checked at:** ${new Date().toISOString()}`,
                `**Triggered by:** ${input.triggeredBy}`,
                '',
                `### Summary`,
                result.summary,
                '',
                `### Details`,
                `- Protection enabled: ${details.protectionEnabled ? '✅' : '❌'}`,
                `- Required reviews: ${details.requiredReviews ? `✅ (${details.reviewCount} reviewer(s))` : '❌'}`,
                `- Status checks: ${details.requiredStatusChecks ? '✅' : '❌'}`,
                `- Enforce admins: ${details.enforceAdmins ? '✅' : '❌'}`,
                `- Force pushes: ${details.allowForcePushes ? '⚠️ Allowed' : '✅ Blocked'}`,
            ].join('\n'),
            type: 'CONFIGURATION',
            category: 'integration',
        };
    }

    // ── Webhook ──

    verifyWebhookSignature(payload: WebhookPayload, secret: string): boolean {
        const sigHeader = payload.headers['x-hub-signature-256'] || '';
        if (!sigHeader) return false;

        // Use the bytes GitHub actually signed. Re-serialising the parsed
        // body (the previous behaviour, kept only as a fallback) is not
        // byte-identical to the wire body, so a correctly-configured secret
        // could still fail verification.
        const rawBody = payload.rawBody
            ?? (typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body));

        return verifyGitHubSignature(rawBody, sigHeader, secret);
    }

    async handleWebhook(
        _ctx: RequestContext,
        payload: WebhookPayload,
        _connectionConfig: Record<string, unknown>
    ): Promise<WebhookProcessResult> {
        const body = payload.body as Record<string, unknown>;
        const action = body.action as string | undefined;

        // Only trigger on branch protection rule changes
        if (payload.eventType === 'branch_protection_rule' || action === 'edited' || action === 'created' || action === 'deleted') {
            logger.info('GitHub webhook: branch protection change detected', {
                component: 'integrations',
                action,
            });

            return {
                status: 'processed',
                triggeredKeys: ['github.branch_protection'],
            };
        }

        return { status: 'ignored' };
    }
}
