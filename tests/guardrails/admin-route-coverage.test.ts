/**
 * Guardrail test: Admin API route authorization coverage.
 *
 * Every admin route file is listed below, and every HTTP handler it exports is
 * wrapped in the permission middleware with THE KEY `ROUTE_PERMISSIONS` names
 * for that URL and method.
 *
 * The key a route enforces is the literal in its `requirePermission(...)`:
 * `ROUTE_PERMISSIONS` is declarative and no request path reads it. So this reads
 * each handler's gate from the syntax tree (`tests/helpers/route-permission-gate.ts`)
 * and compares it with what the map resolves. Re-keying a route, or replacing its
 * gate with a pass-through, now fails here unless the map changes in the same
 * diff, where its `note` has to say why.
 *
 * Until #4441 this test checked only that the text `requirePermission` appeared
 * somewhere in each file. An import line satisfied it, so the signed scanner
 * ingest route could be re-keyed to `controls.view`, or un-gated with its import
 * kept, with every test green.
 *
 * Adding a new admin route? Wrap each handler with
 * `requirePermission('admin.X', …)` from `@/lib/security/permission-middleware`,
 * add the URL to `ROUTE_PERMISSIONS` in `@/lib/security/route-permissions` with
 * the same key, and list the file below. A handler that is deliberately open to
 * every member goes in `UNGATED_HANDLERS` with its reason.
 */
import * as fs from 'fs';
import * as path from 'path';

import { resolveRoutePermission } from '@/lib/security/route-permissions';
import { handlerGates, requirementLabel, type HandlerGate } from '../helpers/route-permission-gate';

// ─── Configuration ───

/**
 * Routes that MUST use the centralized `requirePermission` guard.
 *
 * Format: relative path from src/app/api/t/[tenantSlug]/
 * Every route file listed here is checked for the centralized admin guard import.
 */
const ADMIN_ONLY_ROUTES = [
    // A2A host consumers (#3861). Management is `admin.agent_registry` — a
    // host consumer is "whom may call us", register-shaped (ADR 0003) — and the
    // KILL is `admin.agent_kill_switch`, because the register key bundles admit
    // with suspend and a tenant must be able to delegate STOP without ADMIT.
    'admin/a2a/host-consumers/route.ts',
    'admin/a2a/host-consumers/[hostConsumerId]/route.ts',
    'admin/a2a/host-consumers/[hostConsumerId]/kill/route.ts',
    // The four AI switches (#3914). `admin.tenant_lifecycle`, the OWNER key,
    // because a customer may have undertaken that no model processes their
    // data and the control honouring that cannot sit where day-to-day
    // administration reaches it.
    'admin/ai-features/route.ts',
    'admin/calendar/consent/route.ts',
    // Legacy access recertification (Step 2a). Both admin.manage: PUT decides
    // which legacy column means email and which means employeeNumber, and GET
    // enumerates a customer's legacy schema.
    'admin/legacy-access/profile/route.ts',
    'admin/legacy-access/pull/route.ts',
    'admin/legacy-access/mapping/route.ts',
    'admin/legacy-access/reconcile/route.ts',
    // The latest snapshot's standing, which the connection page reads to drive
    // the pull and reconcile actions. admin.manage, as they are.
    'admin/legacy-access/snapshot/route.ts',
    // Legacy reconciliation queue (Step 4b). NOT admin.manage — these carry
    // identity_reconciliation.view / .confirm. Listed here because the file
    // lives under admin/, and this guard's question is "is every admin route
    // authorised", not "is every admin route admin.manage".
    'admin/legacy-access/queue/route.ts',
    'admin/legacy-access/queue/decide/route.ts',
    'admin/legacy-access/queue/bulk-confirm/route.ts',
    // /admin/* routes
    'admin/members/route.ts',
    'admin/members/[membershipId]/route.ts',
    'admin/members/[membershipId]/deactivate/route.ts',
    // #3675 — a member's line of defence. `admin.owner_management`, OWNER-only.
    'admin/members/[membershipId]/line-of-defence/route.ts',
    'admin/settings/route.ts',
    'admin/scim/route.ts',
    'admin/integrations/route.ts',
    'admin/integrations/diagnostics/route.ts',
    'admin/integrations/health/route.ts',
    // P1 — connection-level run + per-connection outcomes + identity roster.
    'admin/integrations/[connectionId]/sync/route.ts',
    'admin/integrations/[connectionId]/executions/route.ts',
    'admin/integrations/identity-accounts/route.ts',
    // #3672 — the accountable owner of an external agent connection
    // (integration passport P11). admin.manage, the connection-write key.
    'admin/integrations/[connectionId]/owner/route.ts',
    // SP-1 — SharePoint connection management (delegated-consent OAuth)
    'admin/integrations/sharepoint/route.ts',
    'admin/integrations/sharepoint/connect/route.ts',
    'admin/integrations/sharepoint/sites/route.ts',
    'admin/integrations/sharepoint/test/route.ts',
    'admin/roles/route.ts',
    'admin/roles/[roleId]/route.ts',
    // Trust Center — compose (ADMIN) + publish toggle (OWNER). Both use
    // requirePermission; publishing the public page is OWNER-gated.
    'admin/trust-center/route.ts',
    'admin/trust-center/enable/route.ts',
    'admin/api-keys/route.ts',
    'admin/api-keys/[keyId]/route.ts',
    // Agent register (Epic Agentic) — register / amend / activate / suspend /
    // retire an autonomous agent. Gated on `admin.agent_registry`, its own key:
    // an ACTIVE row here is what lets a credential through the /api/mcp
    // registration gate.
    'admin/agents/route.ts',
    'admin/agents/[agentId]/route.ts',
    'admin/agents/[agentId]/status/route.ts',
    // The registration intake (#3669) — a SHADOW_AGENT finding becomes a DRAFT
    // register row through a provisional UNCLASSIFIED AI-system entry. The
    // register's key: it creates a register row.
    'admin/agents/intake/route.ts',
    // The kill switch's two TENANT scopes (one agent / this tenant) — its own
    // key, `admin.agent_kill_switch`. Separate from the register's because
    // agent_registry bundles suspend with ACTIVATE, and stopping must be
    // delegable without admitting. The PLATFORM scope is not here at all: it has
    // no tenant, and lives at /api/admin/agent-kill-switch behind
    // PLATFORM_ADMIN_API_KEY.
    // #3484 — the per-tenant concurrent-run cap. `admin.agent_registry`, not
    // the kill key: a cap bounds how much NEW work may start and stops
    // nothing already running.
    'admin/agents/concurrency/route.ts',
    // #3777 — the monthly token budget, the cap's sibling under the same key.
    'admin/agents/budget/route.ts',
    'admin/agents/kill-switch/route.ts',
    // The owner-orphan pass's mode and recorded passes (#3670) —
    // `admin.tenant_lifecycle`, the identity ladder's key: the mode decides
    // whether a scheduled job stops agents unattended.
    'admin/agents/owner-orphan-pass/route.ts',
    // #3807 — the pilot auditor's set-up, as the signed-in owner (`admin.agent_registry`).
    'admin/agents/audit-pilot/route.ts',
    // #3470 — the Flue skill corpus behind the Skills tab. Read-only, and
    // `admin.agent_registry` rather than the per-agent exposure key: a
    // skill is instruction text delivered to a model and is tenant-wide.
    'admin/agents/skills/route.ts',
    // #3680 — tenant-authored skills: author, edit, evaluate, submit, approve,
    // reject and retire. Their own key, `admin.agent_skill_review`, above the
    // register's catch-all; the approver is never the version's author.
    'admin/agents/skills/tenant/route.ts',
    'admin/agents/skills/tenant/[skillId]/route.ts',
    'admin/agents/skills/tenant/[skillId]/versions/route.ts',
    'admin/agents/skills/tenant/[skillId]/versions/[versionId]/evaluation/route.ts',
    'admin/agents/skills/tenant/[skillId]/versions/[versionId]/submit/route.ts',
    'admin/agents/skills/tenant/[skillId]/versions/[versionId]/approve/route.ts',
    'admin/agents/skills/tenant/[skillId]/versions/[versionId]/reject/route.ts',
    'admin/agents/skills/tenant/[skillId]/versions/[versionId]/retire/route.ts',
    // Deny-by-default MCP tool exposure — its own key,
    // `admin.agent_tool_exposure`, narrower than the register's.
    'admin/agents/[agentId]/tools/route.ts',
    // The two-step agent ownership transfer (#3698) — `admin.agent_ownership`
    // since #3699 (`admin.tenant_lifecycle` before it), NOT the register's key: ADMIN holds `agent_registry`, and an agent's
    // accountable owner must not be movable by the role it is accountable to.
    // Step one (propose), its read and its cancel; then step two, completed by
    // the person it names and never by the person who started it.
    'admin/agents/[agentId]/ownership-transfer/route.ts',
    'admin/agents/[agentId]/ownership-transfer/complete/route.ts',
    // A person confirms which discovered Entra service principal is the
    // agent's own (#3671) — the register's key, `admin.agent_registry`: the
    // condition for an unattended disable of that principal.
    'admin/agents/[agentId]/service-principal-link/route.ts',
    // Which agent answers on Ask (#4629) — the register's key,
    // `admin.agent_registry` (owner decision, 2026-10-30): designating the
    // agent that reads the workspace for every person who asks is register
    // authority, set on the agent's own page.
    'admin/agents/[agentId]/interactive/route.ts',
    // Agent profiles (#4143) — the register's key, `admin.agent_registry`
    // (owner decision 3): authoring, review and the read, with the approver
    // never the author (usecase and CHECK). 404 while AGENT_PROFILES is off.
    'admin/agents/[agentId]/profile/route.ts',
    'admin/agents/[agentId]/profile/versions/route.ts',
    'admin/agents/[agentId]/profile/versions/[version]/submit/route.ts',
    'admin/agents/[agentId]/profile/versions/[version]/approve/route.ts',
    'admin/agents/[agentId]/profile/versions/[version]/reject/route.ts',
    'admin/agents/[agentId]/profile/versions/[version]/retire/route.ts',
    // Step 2c (#4150): start a read-only Test run of a version, as the agent.
    'admin/agents/[agentId]/profile/versions/[version]/test-run/route.ts',
    // The versioned runtime policy card (Agentic 5) — its own key,
    // `admin.agent_policy_card`, and the WIDEST of the three: a card declares
    // the permitted tools, the data rung, the autonomy rung and both action
    // budgets, so sharing the tool-exposure key would make every routine grant
    // carry the authority to raise an agent's ceiling.
    'admin/agents/[agentId]/policy-card/route.ts',
    // The behavioural circuit breaker (OWASP ASI08/ASI10) — the latch an agent's
    // own divergence from its own history can throw, and the audited human act of
    // closing it. Same `admin.agent_registry` key as the register, and for the
    // register's reason: closing a breaker IS the authority to decide that an
    // agent may act. A narrower key would let somebody who cannot activate an
    // agent un-stop one that stopped itself.
    'admin/agents/[agentId]/circuit-breaker/route.ts',
    // Tool-manifest pinning (OWASP ASI04) — the tenant's record of which tool
    // DEFINITION it has accepted, and the audited act of re-approving one that
    // changed. Same `admin.agent_registry` key as the register, and for the same
    // reason: this is tenant-wide rather than per-agent, so approving a rewritten
    // description hands its instructions to every agent at once. That is the
    // register's blast radius, not the per-agent grant's.
    'admin/agents/tool-manifests/route.ts',
    'admin/agents/parameter-sets/route.ts',
    // One human's signature on a proposed edit to a BOUNDED TEMPLATE (#3051
    // step 5b). The same `admin.agent_registry` key as the collection above,
    // deliberately and not by omission: a tenant that could propose a template
    // edit but not sign one would have a queue nobody can clear, and what makes
    // the second signature meaningful is that it is a different PERSON — which
    // a unique index and a trigger enforce — not a different permission.
    'admin/agents/parameter-sets/signatures/route.ts',
    'admin/agents/external-tools/route.ts',
    'admin/integrations/[connectionId]/mcp-consent/route.ts',
    'admin/integrations/[connectionId]/orangehrm-consent/route.ts',
    'admin/integrations/[connectionId]/workday-consent/route.ts',
    // The agent risk assessment (Agentic 3) — read the instrument, answer one
    // question, and score the agent. Same `admin.agent_registry` key as the
    // register: completing a run writes the tier that caps the agent's
    // authority, so this IS the authority to set an agent's authority.
    'admin/agents/[agentId]/risk-assessment/route.ts',
    'admin/agents/[agentId]/risk-assessment/complete/route.ts',
    'admin/agents/[agentId]/coverage/route.ts',
    // Review quality (ASI09) — whether the human gate on what agents propose
    // is real: time-to-decision, approval rate with its denominator, and
    // bulk-approval bursts, all read from columns AgentProposal already keeps.
    // Same `admin.agent_registry` key, matched by the subtree rule: judging the
    // gate and deciding which agents may pass it are one authority, and the
    // surface names people rather than tools.
    'admin/agents/review-quality/route.ts',
    // The assessor-facing governance pack — read-only, gated by the same
    // `admin/agents` subtree rule as the register itself.
    'admin/agents/reports/route.ts',
    // Filing that pack into the evidence library (#2467). The SAME
    // `admin/agents` subtree rule gates it — the rules are path-only, so they
    // cover this POST exactly as they cover the GET above. Listed separately
    // here because this route WRITES: it creates a retained Evidence row per
    // call, where its read-only sibling deliberately writes nothing at all.
    'admin/agents/reports/export/route.ts',
    // Harness ingest (#3665). The scan POST has its own rule,
    // `admin.agent_harness_ingest`, above the subtree rule — a scanner key
    // is scoped to it alone. Keys and acceptances fall to the subtree rule:
    // deciding whose reports count, and accepting a shortfall, are the
    // register's authority.
    'admin/agents/harness-scans/route.ts',
    'admin/agents/harness-scanner-keys/route.ts',
    'admin/agents/harness-scanner-keys/[keyId]/route.ts',
    'admin/agents/harness-acceptances/route.ts',
    // The discovered agents a discovered-agent review is started with (#4472).
    // GET only, its own rule above the subtree rule: the inventory read the
    // harness-scans list and the get_discovered_agent tool take.
    'admin/agents/discovered/route.ts',
    // Client estates (#3678). The GET has its own rule, the inventory read,
    // above the subtree rule; declaring, changing and removing an estate fall
    // to the subtree rule's `admin.agent_registry`.
    'admin/agents/harness-estates/route.ts',
    'admin/agents/harness-estates/[estateId]/route.ts',
    // A2A peers (#3673). Their own rule above the subtree rule, on the same
    // key, `admin.agent_registry`: the owner chose it (residual R3 of
    // docs/a2a-threat-model.md), so it is stated rather than inherited.
    'admin/agents/peers/route.ts',
    'admin/agents/peers/[peerId]/route.ts',
    'admin/agents/peers/[peerId]/card/route.ts',
    'admin/agents/peers/[peerId]/card/approve/route.ts',
    // A2A messaging (#3679). The inbound credential and the receipts fall to
    // the peers rule (`admin.agent_registry`); the kill has its own rule above
    // it, `admin.agent_kill_switch` — the key that stops an agent.
    'admin/agents/peers/[peerId]/inbound-credential/route.ts',
    'admin/agents/peers/[peerId]/kill/route.ts',
    'admin/agents/peers/[peerId]/messages/route.ts',
    // The tenant's own A2A signing key (#3679, owner decision 2026-10-19).
    // Method-scoped rules above the /admin/agents catch-all: GET is the
    // register key, POST (generate or rotate) is admin.tenant_lifecycle.
    'admin/agents/a2a-signing-key/route.ts',
    // Quarantine triage — the proposals the agentic output guard refused, with
    // the content that was attempted. Read-only, gated on
    // `admin.agent_registry` by its own rule in ROUTE_PERMISSIONS (nothing in
    // that map matches /admin/mcp/**, so the rule is what gates the path).
    'admin/mcp/quarantine/route.ts',
    'admin/device-tokens/route.ts',
    'admin/device-tokens/[tokenId]/route.ts',
    'admin/dsar-requests/route.ts',
    'admin/trust-center/documents/route.ts',
    'admin/trust-center/requests/route.ts',
    'admin/trust-center/requests/[requestId]/approve/route.ts',
    // #4824 — deny a waiting request; remove a document on request.
    'admin/trust-center/requests/[requestId]/deny/route.ts',
    'admin/trust-center/documents/[documentId]/route.ts',
    'admin/key-rotation/route.ts',
    'admin/tenant-dek-rotation/route.ts',
    // False-positive quarantine reversal — OWNER-only
    // (admin.tenant_lifecycle), audited FILE_QUARANTINE_CLEARED.
    'admin/files/[fileId]/clear-quarantine/route.ts',
    // The read side of the same escape hatch — the only surface that
    // produces the fileId the reversal consumes. Same OWNER-only key.
    'admin/files/quarantined/route.ts',
    // Bounded AV catch-up rescan trigger — OWNER-only
    // (admin.tenant_lifecycle), the same key as clear-quarantine above
    // because it decides the same thing (what the download gate serves)
    // for a page of files rather than for one. Audited AV_RESCAN_INITIATED.
    'admin/av-rescan/route.ts',
    'admin/agent-driver/route.ts',
    // The owner's Flue wiring checklist on AI features. OWNER-only, the key the
    // agent-driver PUT takes; that route's GET is admin.view (#4139).
    'admin/flue-wiring/route.ts',
    'admin/identity-write-policy/route.ts',
    'admin/process-canvas-module/route.ts',
    // #2861 — the same ladder shape as the identity write policy above, for a
    // different authority: how far an AGENT may go when driving a write to a
    // customer's own third-party system. Same OWNER-only key, because granting
    // the product authority to CHANGE something in a system that is not ours is
    // authority of the same class as disabling an account in their directory.
    //
    // A SIBLING path rather than nested under admin/integrations/<id> on
    // purpose: route-permission matching is first-match-wins and that rule
    // resolves to admin.manage, so nesting would document a weaker gate than
    // the handler enforces. The two identity routes below are siblings for
    // exactly this reason and say so in their own notes.
    'admin/external-write-policy/[connectionId]/route.ts',
    // #2861 — the pairing that makes a write accountable. Same OWNER-only key as
    // the ladder above it, and a sibling path for the same first-match-wins
    // reason.
    'admin/external-prior-state-read/[connectionId]/route.ts',
    // #3672 — one connection's integration passport. OWNER-only because it
    // shows the rung and the pairings the two routes above guard, and a
    // sibling path for the same first-match-wins reason.
    'admin/integration-passport/[connectionId]/route.ts',
    // #3329 — discovery for the grant compose form. READ-ONLY, so admin.manage
    // rather than the OWNER-only key its external-write-policy sibling carries:
    // that one sets how far an agent may go when CHANGING a customer system,
    // whereas knowing which access packages exist grants nothing. Two files
    // rather than one with a mode flag, because policies are read per package —
    // fetching every package's policies to build one payload is an N+1 against
    // a customer's directory on every form load.
    'admin/entra-entitlement/access-packages/route.ts',
    'admin/entra-entitlement/assignment-policies/route.ts',
    // #3330 — mints the grant endpoint's bearer token. OWNER-only for the same
    // reason as the two above: the credential carries authority to change
    // something in a customer's own directory, so handing it out is an exercise
    // of that authority. A sibling path rather than nested under
    // admin/integrations, where first-match-wins would resolve to admin.manage.
    'admin/mcp-server-token/[connectionId]/route.ts',
    'admin/identity-leaver-passes/route.ts',
    // #2687 — the joiner's half of the same pair. The report names which of a
    // customer's people the product would create an account for and at what
    // address. OWNER-only, like the leaver report it mirrors.
    //
    // The `/run` trigger is NOT here yet: it ships in the run-route PR stacked
    // on this one, split because two new API routes together push the CI Build
    // over the runner's memory ceiling (#2698). When it lands it carries its own
    // ROUTE_PERMISSIONS rule, ordered ahead of the subtree one for the same
    // reason the leaver's is.
    'admin/identity-joiner-passes/route.ts',
    'admin/identity-joiner-passes/run/route.ts',
    // The off-schedule RE-RUN trigger. Its sibling above is a read; this is
    // the only endpoint in that subtree that makes the product write to a
    // customer's directory, so it carries its OWN rule in ROUTE_PERMISSIONS
    // ordered ahead of the subtree one — a later softening of the report's
    // gate must not reach the write trigger by inheritance.
    'admin/identity-leaver-passes/run/route.ts',
    'admin/identity-account-protection/[accountId]/route.ts',
    // The read half of the reversal story: what a directory write REPLACED.
    // Two files because the index and the by-reference lookup return different
    // things on purpose — the index never selects the captured prior state, so
    // a page of a hundred rows cannot ship a hundred directory captures to
    // answer "which row was it?". Both are OWNER-only, matched by one subtree
    // rule in ROUTE_PERMISSIONS so they cannot drift apart.
    'admin/identity-write-journal/route.ts',
    'admin/identity-write-journal/[journalId]/route.ts',
    'admin/identity-write-journal/restorable/[accountId]/route.ts',
    'admin/identity-write-journal/unsettled/route.ts',
    'admin/billing/plan/route.ts',
    'admin/rotate-dek/route.ts',
    'admin/sessions/route.ts',
    // Epic 1, PR 3 — token-redemption invite flow (admin invite management)
    'admin/invites/route.ts',
    'admin/invites/[inviteId]/route.ts',

    // Epic 44 — risk matrix configuration
    'admin/risk-matrix-config/route.ts',
    // Tenant security settings — session cap, audit-stream endpoint + HMAC
    // secret, AI guard mode + residency. Admin-only on BOTH verbs: the read
    // reveals whether an outbound streaming endpoint is configured.
    'admin/security-settings/route.ts',
    // The agent-enforcement PRE-FLIGHT (#2443). Read-only: it lists the ACTIVE,
    // UNBOUND credentials the tool boundary would begin refusing. Route-gated on
    // `admin.manage` like its sibling; the usecase additionally requires
    // `admin.agent_registry`, so the write path through the sibling PUT cannot
    // be used to go around the narrower key.
    'admin/security-settings/agent-enforcement/route.ts',
    // The business-data transfer acknowledgement (M5, #3872). Its own route
    // rather than a field on the sibling PUT, because it is a dated act with an
    // author and a patch body would let it be set as a side effect of saving an
    // unrelated form. Route-gated on `admin.manage` like both siblings; the
    // usecase additionally requires a PERSON, so a `*`-scoped API key cannot
    // accept a data transfer on a company's behalf.
    'admin/security-settings/external-ai-acknowledgement/route.ts',

    // Billing routes (admin-only)
    'billing/checkout/route.ts',
    'billing/portal/route.ts',
    'billing/events/route.ts',

    // SSO configuration (admin-only)
    'sso/route.ts',

    // Security management (admin-only mutation/operations)
    'security/sessions/revoke-user/route.ts',
    'security/sessions/revoke-all/route.ts',
    'security/mfa/policy/route.ts',
];

/**
 * Exported handlers under these files that carry NO permission gate, on purpose.
 * Each needs a reason, and the map must hold no rule for it either: a handler
 * the map says is gated and the route leaves open is a failure, not an entry.
 */
const UNGATED_HANDLERS: Readonly<Record<string, string>> = {
    'security/mfa/policy/route.ts GET':
        'Reads the tenant MFA policy for its settings page, which every member '
        + 'sees; the handler resolves the member through getTenantCtx. Only PUT '
        + 'changes the policy, and it is admin.manage.',
};

const BASE_DIR = path.resolve(
    __dirname,
    '../../src/app/api/t/[tenantSlug]'
);

/** The URL the map is matched against, as api-permission-coverage builds it. */
function pathnameOf(routePath: string): string {
    const segments = routePath
        .replace(/\/route\.ts$/, '')
        .split('/')
        .map((seg) => (seg.startsWith('[') && seg.endsWith(']') ? 'stub-id' : seg));
    return `/api/t/acme/${segments.join('/')}`;
}

/** Why one handler's gate disagrees with the map, or null when it agrees. */
function gateProblem(routePath: string, method: string, gate: HandlerGate): string | null {
    const rule = resolveRoutePermission(pathnameOf(routePath), method);
    const expected = rule
        ? requirementLabel(
            (Array.isArray(rule.permission) ? rule.permission : [rule.permission]) as string[],
            rule.mode,
        )
        : null;

    if (gate.kind === 'unreadable') {
        return `its gate's requirement is not a literal (${gate.why}), so no test can say which key it enforces`;
    }
    if (gate.kind === 'ungated') {
        if (expected !== null) return `no permission gate wraps it, but ROUTE_PERMISSIONS names ${expected}`;
        return `${routePath} ${method}` in UNGATED_HANDLERS
            ? null
            : 'no permission gate wraps it, and it is not in UNGATED_HANDLERS';
    }
    const actual = requirementLabel(gate.keys, gate.mode);
    if (expected === null) return `the route enforces ${actual}, and ROUTE_PERMISSIONS has no rule for it`;
    return actual === expected ? null : `the route enforces ${actual}, ROUTE_PERMISSIONS names ${expected}`;
}

// ─── Tests ───

describe('Admin API route authorization coverage', () => {
    // Each exported handler enforces the key the map names for its URL + method.
    for (const routePath of ADMIN_ONLY_ROUTES) {
        const displayPath = `api/t/[tenantSlug]/${routePath}`;

        test(`${displayPath}: every exported handler enforces the key ROUTE_PERMISSIONS names`, () => {
            const fullPath = path.join(BASE_DIR, routePath);
            expect(fs.existsSync(fullPath)).toBe(true);

            const gates = handlerGates(fs.readFileSync(fullPath, 'utf-8'), routePath);
            expect(gates.size).toBeGreaterThan(0);

            const problems: string[] = [];
            for (const [method, gate] of gates) {
                const problem = gateProblem(routePath, method, gate);
                if (problem) problems.push(`${method}: ${problem}`);
            }
            expect(problems).toEqual([]);
        });
    }

    test('every UNGATED_HANDLERS entry is a listed route whose handler is still ungated', () => {
        const stale: string[] = [];
        for (const entry of Object.keys(UNGATED_HANDLERS)) {
            const [routePath, method] = entry.split(' ');
            const fullPath = path.join(BASE_DIR, routePath);
            const gate = ADMIN_ONLY_ROUTES.includes(routePath) && fs.existsSync(fullPath)
                ? handlerGates(fs.readFileSync(fullPath, 'utf-8'), routePath).get(method as never)
                : undefined;
            if (gate?.kind !== 'ungated') stale.push(entry);
        }
        expect(stale).toEqual([]);
    });

    test('positive control: the signed scanner ingest is held to its own key', () => {
        // The route #4441 was proven on. If this reads anything else, the
        // analyser stopped seeing the gate and every route test above is vacuous.
        const routePath = 'admin/agents/harness-scans/route.ts';
        const gates = handlerGates(fs.readFileSync(path.join(BASE_DIR, routePath), 'utf-8'), routePath);
        expect(gates.get('POST')).toEqual({ kind: 'gated', keys: ['admin.agent_harness_ingest'], mode: 'all' });
        expect(gateProblem(routePath, 'POST', { kind: 'gated', keys: ['controls.view'], mode: 'all' }))
            .toMatch(/^the route enforces controls\.view, ROUTE_PERMISSIONS names admin\.agent_harness_ingest/);
        expect(gateProblem(routePath, 'POST', { kind: 'ungated' })).toMatch(/^no permission gate wraps it/);
    });

    // Scan for new admin/* route files not in the allowlist
    test('no admin/* route file exists without being listed in ADMIN_ONLY_ROUTES', () => {
        const adminDir = path.join(BASE_DIR, 'admin');
        if (!fs.existsSync(adminDir)) return;

        const routeFiles: string[] = [];
        function walk(dir: string, prefix: string) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), rel);
                } else if (entry.name === 'route.ts') {
                    routeFiles.push(`admin/${rel}`);
                }
            }
        }
        walk(adminDir, '');

        const missing = routeFiles.filter(
            f => !ADMIN_ONLY_ROUTES.includes(f)
        );

        expect(missing).toEqual([]);
    });
});
