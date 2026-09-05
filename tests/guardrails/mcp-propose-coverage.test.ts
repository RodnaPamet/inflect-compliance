/**
 * MCP propose-not-commit coverage ratchet (Phase 3) — the single most important
 * MCP guard.
 *
 * The load-bearing safety property of the whole MCP effort: an external agent
 * can PROPOSE but never COMMIT. A propose tool writes a PENDING AgentProposal; a
 * human approves it before the real create-usecase runs. A hallucinating or
 * prompt-injected agent therefore cannot create a live compliance record.
 *
 * This guard locks:
 *   - propose tools NEVER import an entity create/update/delete usecase — they
 *     only call `createAgentProposal` (the queue);
 *   - the approval usecase runs the REAL create usecases (create*), audited as
 *     a HUMAN action with agent attribution;
 *   - propose tools require the `mcp:propose` capability scope (strictly >
 *     `mcp:read`); there is no `mcp:write` / write-direct scope;
 *   - proposed content is validated against the create-schema + sanitised
 *     (Epic D) before queueing;
 *   - the AgentProposal model is RLS-protected + encrypted + index-covered.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VALID_SCOPES } from '@/lib/auth/api-key-auth';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// SOURCE reads are comment-masked at the seam: neither the propose-not-commit
// negative nor the "runs the real create usecases" positive may be decided by
// a comment. Markdown and migration SQL stay raw.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (rel: string) => {
    const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return CODE_FILE.test(rel) ? codeOf(raw) : raw;
};

const proposeTools = read('src/lib/mcp/tools/propose-tools.ts');
const usecase = read('src/app-layer/usecases/agent-proposals.ts');

describe('MCP propose — the propose-not-commit lock', () => {
    it('propose tools NEVER import an entity create/update/delete usecase', () => {
        // The one thing this PR cannot ship: a propose tool that creates a real
        // record. It may only call `createAgentProposal` (the queue).
        const entityMutators = /\b(createRisk|createControl|createPolicy|createFinding|updateRisk|deleteRisk|applySession)\b/;
        expect(proposeTools).not.toMatch(entityMutators);
        // It DOES go through the proposal queue.
        expect(proposeTools).toMatch(/createAgentProposal/);
        expect(proposeTools).toMatch(/from ['"]@\/app-layer\/usecases\/agent-proposals['"]/);
    });

    it('the approval usecase runs the REAL create usecases (the commit happens on human approval)', () => {
        for (const fn of ['createRisk', 'createControl', 'createPolicy', 'createFinding']) {
            expect(usecase).toMatch(new RegExp(`\\b${fn}\\b`));
        }
        // Approval is a privileged human action.
        expect(usecase).toMatch(/assertCanWrite/);
    });

    it('approval audits the commit as a HUMAN action with agent attribution', () => {
        const approveBlock = usecase.slice(usecase.indexOf('approveAgentProposal'));
        expect(approveBlock).toMatch(/actorType:\s*['"]USER['"]/);
        expect(approveBlock).toMatch(/AGENT_PROPOSAL_APPROVED/);
        expect(approveBlock).toMatch(/proposedByApiKeyId/);
    });
});

describe('MCP propose — scope model', () => {
    it('propose tools require the mcp:propose capability (strictly more privileged than read)', () => {
        // The capability moved from an inline call in the runner into the one
        // gate, where it sits beside the exposure allowlist, the resource scope
        // and the principal's create permission — so a refusal at any of them
        // writes exactly one audit row, in one place. The runner DECLARES the
        // capability and the gate ENFORCES it; both halves are asserted, each
        // bounded to the function that owns it, because either alone would pass
        // while the other was gone.
        expect(functionBodyOf(proposeTools, 'runProposeTool')).toMatch(
            /capability:\s*['"]propose['"]/,
        );
        const gate = functionBodyOf(read('src/lib/mcp/authorize.ts'), 'authorizeToolCall');
        expect(gate).toMatch(/enforceMcpCapability\(/);
    });

    it('mcp:propose is a valid scope; there is NO write-direct scope', () => {
        expect(VALID_SCOPES).toContain('mcp:propose');
        expect(VALID_SCOPES).not.toContain('mcp:write');
        expect(VALID_SCOPES).not.toContain('mcp:write-direct');
    });
});

describe('MCP propose — boundary validation + sanitisation', () => {
    it('proposed content is validated against the create-schema before queueing', () => {
        expect(usecase).toMatch(/CreateRiskSchema/);
        expect(usecase).toMatch(/CreateControlSchema/);
        expect(usecase).toMatch(/CreatePolicySchema/);
        expect(usecase).toMatch(/CreateFindingSchema/);
        expect(usecase).toMatch(/\.safeParse\(/);
    });

    it('proposed free text is sanitised (Epic D) at the boundary before it enters the queue', () => {
        expect(usecase).toMatch(/sanitizePlainText/);
        expect(usecase).toMatch(/from ['"]@\/lib\/security\/sanitize['"]/);
    });
});

describe('MCP propose — AgentProposal model hardening', () => {
    it('AgentProposal free-text is encrypted at rest (Epic B)', () => {
        expect(ENCRYPTED_FIELDS.AgentProposal).toBeDefined();
        expect(ENCRYPTED_FIELDS.AgentProposal).toContain('rationale');
        expect(ENCRYPTED_FIELDS.AgentProposal).toContain('payloadJson');
    });

    it('AgentProposal is index-covered on (tenantId, status, createdAt)', () => {
        const schema = readPrismaSchema();
        const block = schema.slice(schema.indexOf('model AgentProposal'));
        expect(block).toMatch(/@@index\(\[tenantId, status, createdAt\]\)/);
    });

    it('AgentProposal has RLS tenant-isolation policies in a migration', () => {
        const mig = read('prisma/migrations/20260701140000_mcp_agent_proposal/migration.sql');
        expect(mig).toMatch(/ENABLE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/FORCE ROW LEVEL SECURITY/);
        expect(mig).toMatch(/CREATE POLICY tenant_isolation ON "AgentProposal"/);
        expect(mig).toMatch(/CREATE POLICY superuser_bypass ON "AgentProposal"/);
    });
});

describe('MCP propose — AISVS C9/C10 write-surface documented', () => {
    it('the implementation note covers the agentic write surface against AISVS C9/C10', () => {
        const note = read('docs/implementation-notes/2026-07-01-mcp-propose-writes.md');
        expect(note).toMatch(/AISVS/);
        expect(note).toMatch(/C9/);
        expect(note).toMatch(/C10/);
        expect(note).toMatch(/propose-not-commit/i);
    });
});
