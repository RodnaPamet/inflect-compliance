/**
 * Agentic workflow-engine coverage ratchet (Epic Agentic 1A) — extends the
 * propose-not-commit lock to MULTI-STEP orchestration.
 *
 * THE LOAD-BEARING PROPERTY: an agentic workflow does many steps, some of which
 * propose writes. Every write STILL routes through the propose-not-commit
 * approval queue — the engine can commit nothing a single MCP tool couldn't.
 * Multi-step ≠ multi-privilege. This guard locks:
 *   - the engine COMPOSES the existing MCP tools (runReadTool / runProposeTool)
 *     and NEVER imports an entity create/update/delete usecase — no step commits
 *     a write directly;
 *   - the engine runs in the MCP tenant/RLS context (no raw Prisma / repository);
 *   - per-run step + token + wall-clock caps are enforced, and abort works
 *     mid-run;
 *   - every step audits with agent attribution;
 *   - the `mcp:orchestrate` scope (strictly > mcp:propose) gates run creation;
 *   - a failed step leaves no half-applied mutation (proposals only);
 *   - the run/step models are RLS-protected + encrypted + index-covered.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VALID_SCOPES } from '@/lib/auth/api-key-auth';
import { ENCRYPTED_FIELDS } from '@/lib/security/encrypted-fields';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));

const engine = read('src/app-layer/usecases/workflow-runs.ts');
const types = read('src/lib/agentic/workflow-types.ts');

describe('Agentic engine — propose-not-commit across steps', () => {
    it('composes the existing MCP tools (runReadTool + runProposeTool)', () => {
        expect(engine).toMatch(/runReadTool/);
        expect(engine).toMatch(/runProposeTool/);
        expect(engine).toMatch(/from ['"]@\/lib\/mcp\/tools\/registry['"]/);
        expect(engine).toMatch(/from ['"]@\/lib\/mcp\/tools\/propose-tools['"]/);
    });

    it('NO workflow step imports an entity create/update/delete usecase (no direct commit)', () => {
        // Writes go ONLY through runProposeTool → createAgentProposal (the queue).
        const entityMutators = /\b(createRisk|createControl|createPolicy|createFinding|updateRisk|deleteRisk|applySession|approveAgentProposal)\b/;
        expect(engine).not.toMatch(entityMutators);
    });

    it('the engine goes through a usecase context, never raw Prisma / repositories', () => {
        expect(engine).not.toMatch(/from ['"]@\/lib\/prisma['"]/);
        expect(engine).not.toMatch(/from ['"]@\/app-layer\/repositories/);
        // It DOES bind RLS per tenant (it's a usecase).
        expect(engine).toMatch(/runInTenantContext/);
    });
});

describe('Agentic engine — guardrails', () => {
    it('enforces per-run step + token + wall-clock caps', () => {
        expect(types).toMatch(/MAX_STEPS/);
        expect(types).toMatch(/MAX_TOKENS/);
        expect(types).toMatch(/WALL_CLOCK_MS/);
        expect(engine).toMatch(/ENGINE_CAPS\.MAX_STEPS/);
        expect(engine).toMatch(/ENGINE_CAPS\.MAX_TOKENS/);
        expect(engine).toMatch(/ENGINE_CAPS\.WALL_CLOCK_MS/);
        // A breach fails the run (not a half-applied mess).
        expect(engine).toMatch(/failRun\(/);
    });

    it('abort works mid-run (the executor checks for ABORTED between steps)', () => {
        expect(engine).toMatch(/status === 'ABORTED'/);
        expect(engine).toMatch(/export async function abortWorkflowRun/);
    });

    it('every step audits with agent attribution', () => {
        // recordStep writes both a WorkflowStep row AND an audit entry.
        const recordBlock = engine.slice(engine.indexOf('async function recordStep'));
        expect(recordBlock).toMatch(/appendAuditEntry\(/);
        expect(recordBlock).toMatch(/actorType:/);
        expect(recordBlock).toMatch(/apiKeyId:/);
    });
});

describe('Agentic engine — scope + model hardening', () => {
    it('mcp:orchestrate gates run creation (strictly more privileged than mcp:propose)', () => {
        const startBlock = engine.slice(engine.indexOf('export async function startWorkflowRun'));
        expect(startBlock).toMatch(/enforceMcpCapability\(\s*ctx\s*,\s*['"]orchestrate['"]\s*\)/);
        expect(VALID_SCOPES).toContain('mcp:orchestrate');
        expect(VALID_SCOPES).not.toContain('mcp:write');
    });

    it('WorkflowRun + WorkflowStep free-text is encrypted at rest (Epic B)', () => {
        expect(ENCRYPTED_FIELDS.WorkflowRun).toEqual(expect.arrayContaining(['contextJson', 'summary']));
        expect(ENCRYPTED_FIELDS.WorkflowStep).toEqual(expect.arrayContaining(['inputJson', 'outputJson']));
    });

    it('WorkflowRun + WorkflowStep have RLS tenant-isolation in a migration', () => {
        const mig = read('prisma/migrations/20260701150000_agentic_workflow_engine/migration.sql');
        for (const tbl of ['WorkflowRun', 'WorkflowStep']) {
            expect(mig).toMatch(new RegExp(`ALTER TABLE "${tbl}" FORCE ROW LEVEL SECURITY`));
            expect(mig).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${tbl}"`));
            expect(mig).toMatch(new RegExp(`CREATE POLICY superuser_bypass ON "${tbl}"`));
        }
    });
});

describe('Agentic engine — AISVS agentic-orchestration documented', () => {
    it('the implementation note records the composes-MCP-not-new-authority design', () => {
        // Markdown: RAW on purpose — this assertion is about the note's prose.
        const note = readRaw('docs/implementation-notes/2026-07-01-agentic-workflow-engine.md');
        expect(note).toMatch(/propose-not-commit/i);
        expect(note).toMatch(/multi-step|orchestrat/i);
        expect(note).toMatch(/AISVS|C9/);
    });
});
