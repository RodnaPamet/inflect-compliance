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
import { resilientFetch } from '../../http-resilience';

// ─── GitHub API Types ────────────────────────────────────────────────

/**
 * `GET /repos/{owner}/{repo}/branches/{branch}/protection`.
 *
 * EVERY KEY IS OPTIONAL, and that is the correction (#3433). This interface
 * declared them as `X | null` REQUIRED properties — i.e. it asserted the API
 * always sends the key and may null it. GitHub does the opposite: it OMITS a key
 * whose requirement is not configured. Verified against a live repository, whose
 * 200 response was exactly:
 *
 *     {"url":…,"required_signatures":{"enabled":false},
 *      "enforce_admins":{"enabled":false},"required_linear_history":{…},
 *      "allow_force_pushes":{"enabled":false},"allow_deletions":{…},
 *      "block_creations":{…},"required_conversation_resolution":{…},
 *      "lock_branch":{…},"allow_fork_syncing":{…}}
 *
 * — with `required_status_checks` and `required_pull_request_reviews` absent.
 *
 * The old shape is why no test could have caught the defect it caused: a fixture
 * with the key MISSING would not typecheck, so every fixture wrote `null`, and
 * `!== null` behaved in the suite and only differed against the endpoint. The
 * type made the failing input inexpressible.
 */
export interface GitHubBranchProtection {
    url: string;
    required_status_checks?: {
        strict: boolean;
        contexts: string[];
    } | null;
    enforce_admins?: { enabled: boolean } | null;
    required_pull_request_reviews?: {
        required_approving_review_count: number;
        dismiss_stale_reviews: boolean;
        require_code_owner_reviews: boolean;
    } | null;
    restrictions?: unknown;
    required_linear_history?: { enabled: boolean } | null;
    allow_force_pushes?: { enabled: boolean } | null;
    allow_deletions?: { enabled: boolean } | null;
}

/**
 * Fetch function type for dependency injection (testability).
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ─── GitHub API Client ───────────────────────────────────────────────

/**
 * One entry from `GET /repos/{owner}/{repo}/rules/branches/{branch}` — the
 * rules ALREADY IN EFFECT on a branch, org-level and repo-level rulesets
 * merged, each tagged with where it came from.
 *
 * Rulesets are GitHub's successor to classic branch protection and are
 * configured independently of it, so reading only the classic endpoint
 * understates a branch's posture (#3433). Captured verbatim from
 * `RodnaPamet/inflect-compliance` `main` on 2026-10-11:
 *
 *     [{"type":"copilot_code_review","ruleset_id":19449061,"ruleset_source_type":"Repository"},
 *      {"type":"deletion","ruleset_id":20952644,"ruleset_source_type":"Repository"},
 *      {"type":"non_fast_forward","ruleset_id":20952644,...},
 *      {"type":"required_status_checks","ruleset_id":20952644,...},
 *      {"type":"merge_queue","ruleset_id":20952644,...}]
 *
 * ...while the CLASSIC endpoint on the same branch returned
 * `required_status_checks: null` and `required_pull_request_reviews: null`.
 * Six contexts (Lint, Typecheck, Test, Build, Security, Ratchets) are
 * required and enforced; the classic read saw none of them.
 *
 * `parameters` is deliberately loose. The `required_status_checks` shape is
 * captured live (above). The `pull_request` shape is DOCUMENTED BUT NOT
 * OBSERVED — no ruleset on the repository used for this work has one — so
 * the reviews half below reads it defensively and the record says so. That
 * distinction is the whole point of `mappingVerifiedBy` (#3431).
 */
export interface GitHubBranchRule {
    type: string;
    ruleset_id?: number;
    ruleset_source_type?: string;
    ruleset_source?: string;
    parameters?: {
        required_approving_review_count?: number;
        dismiss_stale_reviews_on_push?: boolean;
        require_code_owner_review?: boolean;
        required_status_checks?: Array<{ context: string; integration_id?: number }>;
        strict_required_status_checks_policy?: boolean;
    };
}

/**
 * Fetch the rulesets in effect on a branch.
 *
 * Returns `[]` for 404 — a repository with no rulesets, which is a real
 * answer and NOT an error. An auth/other failure returns `rules: null`, which
 * the evaluator must treat as "could not look" rather than "nothing there":
 * a failed probe means unknown, never zero.
 */
export async function fetchBranchRules(
    owner: string,
    repo: string,
    branch: string,
    token: string,
    fetchImpl: FetchFn = resilientFetch
): Promise<{ rules: GitHubBranchRule[] | null; status: number; error?: string }> {
    const url = `https://api.github.com/repos/${owner}/${repo}/rules/branches/${branch}`;
    try {
        const response = await fetchImpl(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (response.status === 200) {
            const data = await response.json() as GitHubBranchRule[];
            return { rules: Array.isArray(data) ? data : [], status: 200 };
        }
        if (response.status === 404) return { rules: [], status: 404 };
        const errorBody = await response.text().catch(() => '');
        return { rules: null, status: response.status, error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}` };
    } catch (err) {
        return { rules: null, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Fetch branch protection rules from GitHub API.
 * Supports dependency-injected fetch for testing.
 */
export async function fetchBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    token: string,
    fetchImpl: FetchFn = resilientFetch
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
 * Evaluate a branch's protection posture and produce a check result.
 * Pure function — no I/O, fully testable.
 *
 * Reads BOTH mechanisms (#3433). Classic branch protection and rulesets are
 * configured independently, so either can carry a requirement the other
 * knows nothing about, and a branch protected solely by a ruleset 404s on the
 * classic endpoint. Taking that 404 as proof of no protection is how this
 * reported our own `main` — six required status checks, force-pushes and
 * deletions blocked — as having none of it.
 *
 * `rules` distinguishes three states, and the distinction is load-bearing:
 *   - `[]`     no rulesets apply (a real answer, and the default: a caller
 *              asking only the classic question gets the classic answer)
 *   - `[...]`  these rules are in effect
 *   - `null`   the rulesets endpoint could NOT be read
 *
 * `null` must not read as `[]`. A failed probe means unknown, never zero —
 * otherwise a token lacking the scope to list rulesets silently downgrades
 * every ruleset-protected branch to "unprotected", which is the original
 * defect with a different cause. The default is `[]` rather than `null` so
 * that classic-only callers are not told rulesets were unreadable when
 * nobody asked about them; the PRODUCTION path always passes the argument
 * explicitly, and `p2-github-passes-rulesets` in
 * `tests/guards/partial-mock-of-a-guarded-barrel.test.ts` enforces that.
 */
export function evaluateBranchProtection(
    owner: string,
    repo: string,
    branch: string,
    protection: GitHubBranchProtection | null,
    apiStatus: number,
    rules: GitHubBranchRule[] | null = []
): CheckResult {
    const repoRef = `${owner}/${repo}:${branch}`;
    const ruleTypes = new Set((rules ?? []).map((r) => r.type));
    const rulesetsUnread = rules === null;
    // A `pull_request` rule carries the review requirement. Its parameter
    // shape is documented but UNOBSERVED (see GitHubBranchRule), so treat the
    // rule's presence as the requirement and the count as a bonus when sent.
    const prRule = (rules ?? []).find((r) => r.type === 'pull_request');
    const rulesetReviews = prRule !== undefined
        && (prRule.parameters?.required_approving_review_count ?? 1) >= 1;
    const rulesetStatusChecks = ruleTypes.has('required_status_checks');
    const rulesetBlocksForcePush = ruleTypes.has('non_fast_forward');
    const rulesetContexts = (rules ?? [])
        .filter((r) => r.type === 'required_status_checks')
        .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));

    // No CLASSIC protection — which is not the same as no protection. A
    // ruleset-only branch lands here with a 404 and may be fully governed.
    if (!protection || apiStatus === 404) {
        // Nothing is protecting this branch, and we DID look. Keep the
        // original wording for the original situation — the richer summary
        // below is for when rulesets are in play or could not be read.
        if (ruleTypes.size === 0 && !rulesetsUnread) {
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
        const checks = {
            protectionEnabled: rulesetStatusChecks || rulesetReviews || ruleTypes.size > 0,
            requiredReviews: rulesetReviews,
            requiredStatusChecks: rulesetStatusChecks,
            enforceAdmins: false,
            // Only claim force-pushes are allowed when we actually looked and
            // found nothing blocking them.
            allowForcePushes: !rulesetBlocksForcePush,
            dismissStaleReviews: prRule?.parameters?.dismiss_stale_reviews_on_push ?? false,
            requireCodeOwnerReviews: prRule?.parameters?.require_code_owner_review ?? false,
            reviewCount: prRule?.parameters?.required_approving_review_count ?? 0,
            classicProtection: false,
            rulesetRules: [...ruleTypes].sort(),
            rulesetsUnread,
        };
        const passed = checks.requiredReviews && checks.requiredStatusChecks;
        const parts = [
            'Classic branch protection: not enabled',
            rulesetsUnread
                ? 'Rulesets: COULD NOT BE READ (posture unknown, not absent)'
                : ruleTypes.size === 0
                  ? 'Rulesets: none apply'
                  : `Rulesets in effect: ${[...ruleTypes].sort().join(', ')}`,
            `Required reviews: ${checks.requiredReviews ? `${checks.reviewCount || 1}+ reviewer(s) via ruleset` : 'NOT configured'}`,
            `Status checks: ${rulesetStatusChecks ? `required via ruleset${rulesetContexts.length ? ` (${rulesetContexts.join(', ')})` : ''}` : 'NOT required'}`,
            `Force pushes: ${checks.allowForcePushes ? 'ALLOWED' : 'blocked by ruleset'}`,
        ];
        return {
            status: passed ? 'PASSED' : 'FAILED',
            summary: `${repoRef}: ${passed ? 'PASS' : 'FAIL'} — ${parts.join('; ')}`,
            details: { repository: `${owner}/${repo}`, branch, ...checks },
        };
    }

    // Evaluate individual rules
    //
    // `!= null` (LOOSE), not `!== null`. GitHub OMITS these keys when the branch
    // has no such requirement rather than returning `null` — verified against a
    // live repository (#3433), whose 200 response contained neither key:
    //
    //     {"url":…,"required_signatures":{…},"enforce_admins":{"enabled":false},
    //      "required_linear_history":{…},"allow_force_pushes":{"enabled":false},…}
    //
    // With `!==`, `undefined !== null` is TRUE, so an absent requirement read as
    // a present one. `requiredReviews` survived that by accident — it is
    // `hasReviews && reviewCount >= 1`, and the `?? 0` on the count made the
    // verdict right for the wrong reason. `requiredStatusChecks` had no such
    // second term, so it was wrongly `true` whenever the key was absent: the
    // evidence record stated a requirement that did not exist, and a repository
    // WITH reviews and WITHOUT status checks passed the whole control.
    const hasReviews = protection.required_pull_request_reviews != null;
    const reviewCount = protection.required_pull_request_reviews?.required_approving_review_count ?? 0;
    const hasStatusChecks = protection.required_status_checks != null;
    const enforceAdmins = protection.enforce_admins?.enabled ?? false;
    const allowForcePushes = protection.allow_force_pushes?.enabled ?? false;
    const dismissStaleReviews = protection.required_pull_request_reviews?.dismiss_stale_reviews ?? false;
    const requireCodeOwnerReviews = protection.required_pull_request_reviews?.require_code_owner_reviews ?? false;

    // Either mechanism satisfies a requirement; neither can revoke the other's.
    // This is the case our own `main` exercises: classic protection returns
    // 200 with both keys null while a ruleset requires six contexts.
    const checks = {
        protectionEnabled: true,
        requiredReviews: (hasReviews && reviewCount >= 1) || rulesetReviews,
        requiredStatusChecks: hasStatusChecks || rulesetStatusChecks,
        enforceAdmins,
        // A ruleset's `non_fast_forward` blocks force-pushes regardless of what
        // classic protection permits.
        allowForcePushes: allowForcePushes && !rulesetBlocksForcePush,
        dismissStaleReviews: dismissStaleReviews || (prRule?.parameters?.dismiss_stale_reviews_on_push ?? false),
        requireCodeOwnerReviews: requireCodeOwnerReviews || (prRule?.parameters?.require_code_owner_review ?? false),
        reviewCount: Math.max(reviewCount, prRule?.parameters?.required_approving_review_count ?? 0),
        classicProtection: true,
        rulesetRules: [...ruleTypes].sort(),
        rulesetsUnread,
    };

    // PASS if minimum security is met: reviews enabled + status checks required
    const passed = checks.requiredReviews && checks.requiredStatusChecks;

    // Name WHICH mechanism carries each requirement. An auditor reading the
    // evidence needs to know where to look to change it, and "required" with
    // no source sent them to the classic settings page that says nothing.
    const via = (classic: boolean, ruleset: boolean): string =>
        classic && ruleset ? 'both' : ruleset ? 'ruleset' : 'branch protection';
    const summaryParts: string[] = [];
    summaryParts.push(`Branch protection: enabled`);
    if (rulesetsUnread) {
        summaryParts.push('Rulesets: COULD NOT BE READ (posture may be understated)');
    } else if (ruleTypes.size > 0) {
        summaryParts.push(`Rulesets in effect: ${[...ruleTypes].sort().join(', ')}`);
    }
    // Keyed on PRESENCE, not on the verdict. A reviews block that exists and
    // requires ZERO approvals is a different fact from no block at all, and
    // #3435 turned on exactly that distinction: an absent requirement must not
    // render as a requirement of zero. Collapsing both to "NOT configured"
    // would throw that away from the other side.
    summaryParts.push(
        `Required reviews: ${
            checks.requiredReviews
                ? `${checks.reviewCount || 1} reviewer(s) via ${via(hasReviews && reviewCount >= 1, rulesetReviews)}`
                : hasReviews
                  ? `${reviewCount} reviewer(s) — does NOT meet the requirement`
                  : 'NOT configured'
        }`,
    );
    summaryParts.push(
        `Status checks: ${
            checks.requiredStatusChecks
                ? `required via ${via(hasStatusChecks, rulesetStatusChecks)}${rulesetContexts.length ? ` (${rulesetContexts.join(', ')})` : ''}`
                : 'NOT required'
        }`,
    );
    summaryParts.push(`Enforce admins: ${enforceAdmins ? 'yes' : 'no'}`);
    summaryParts.push(
        `Force pushes: ${checks.allowForcePushes ? 'ALLOWED' : `blocked${rulesetBlocksForcePush && allowForcePushes ? ' by ruleset' : ''}`}`,
    );

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
        this.fetchImpl = fetchImpl ?? resilientFetch;
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

        // Read rulesets too (#3433) — AFTER the error return, so a failed
        // protection read does not spend a second doomed request. A failure
        // here does NOT fail the check: it yields `null`, which the evaluator
        // reports as "posture may be understated" rather than silently
        // claiming nothing is configured.
        const { rules } = await fetchBranchRules(owner, repo, branch, token, this.fetchImpl);

        const result = evaluateBranchProtection(owner, repo, branch, protection, status, rules);
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

        // GitHub names the event in a HEADER; the body carries only `action`.
        // `payload.eventType` is derived in webhook-processor.ts from
        // `body.action ?? body.event_type`, so for a real branch_protection_rule
        // delivery it holds 'created' | 'edited' | 'deleted' — never
        // 'branch_protection_rule'. Requiring the event type WITHOUT reading the
        // header would make this branch unreachable in production.
        const eventName = payload.headers['x-github-event'] || payload.eventType || '';

        // Only trigger on branch protection rule changes.
        //
        // This was `||` throughout, so the event type was not required and ANY
        // GitHub delivery whose body carried one of these actions — issues,
        // pull_request, label, milestone, release — was recorded as a
        // branch-protection change. On a compliance product that is a false
        // control signal, not just noise.
        if (eventName === 'branch_protection_rule' && (action === 'edited' || action === 'created' || action === 'deleted')) {
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
