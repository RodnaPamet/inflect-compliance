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
import { mdSection } from '../helpers/markdown-regions';
import { codeOf, declarationOf, sqlCodeOf, functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read = (rel: string) => codeOf(readRaw(rel));
/** The one place a `WorkflowStep` is written — see the seam guard. */
const recorder = read('src/lib/agentic/drivers/step-recorder.ts');
// LANGUAGE SPLIT (#2644). `codeOf` lexes `//`, so on a `.sql` file it blanks
// nothing and a `--` comment reaches the assertion verbatim — masked at the
// call site, unmasked in fact. Migrations go through `sqlCodeOf`, which lexes
// `--` and `/* */`; TypeScript keeps `read`.
const readSql = (rel: string) => sqlCodeOf(readRaw(rel));

// THE ENGINE IS TWO FILES since the driver seam landed: the usecase shell that
// starts, resumes and aborts a run, and the driver that walks its steps. Every
// assertion below is pointed at the half that owns it — `engine` for the
// usecase's own surface, `driver` for the execution walk — rather than at a
// concatenation, which would let an assertion pass because the OTHER file
// satisfied it.
const engine = read('src/app-layer/usecases/workflow-runs.ts');
const driver = read('src/lib/agentic/drivers/static-driver.ts');
// A THIRD half since the Flue driver landed: how a run reaches a terminal
// state is not a property of one engine, so `updateRun` / `failRun` /
// `haltRunAtCap` were extracted where both can reach them.
const settlement = read('src/lib/agentic/drivers/run-settlement.ts');
const flueRun = read('src/lib/agentic/flue/execute.ts');
const types = read('src/lib/agentic/workflow-types.ts');
const runCaps = read('src/lib/agentic/run-caps.ts');

describe('Agentic engine — propose-not-commit across steps', () => {
    it('composes the existing MCP tools (runReadTool + runProposeTool)', () => {
        expect(driver).toMatch(/runReadTool/);
        expect(driver).toMatch(/runProposeTool/);
        expect(driver).toMatch(/from ['"]@\/lib\/mcp\/tools\/registry['"]/);
        expect(driver).toMatch(/from ['"]@\/lib\/mcp\/tools\/propose-tools['"]/);
    });

    it('NO workflow step imports an entity create/update/delete usecase (no direct commit)', () => {
        // Writes go ONLY through runProposeTool → createAgentProposal (the queue).
        const entityMutators = /\b(createRisk|createControl|createPolicy|createFinding|updateRisk|deleteRisk|applySession|approveAgentProposal)\b/;
        // BOTH halves. The invariant is "the engine never writes a business
        // entity directly", and checking only the usecase after the execution
        // walk moved out would have left the half that actually runs tools
        // unchecked.
        //
        // Written as ONE assertion over both sources rather than two, and that
        // is not style. `entityMutators` is a variable, so its needle is not a
        // literal the Class D analyser can read — every such site counts
        // against `UNANALYSABLE_READ_BASELINE`, a zero-slack ceiling that only
        // moves down. Two sites would have added one to it for no extra
        // coverage; a loop checks both halves from a single site.
        for (const [half, src] of [
            ['usecase', engine],
            ['driver', driver],
        ] as const) {
            expect({ half, writesEntities: entityMutators.test(src) }).toEqual({
                half,
                writesEntities: false,
            });
        }
    });

    it('the engine goes through a usecase context, never raw Prisma / repositories', () => {
        expect(engine).not.toMatch(/from ['"]@\/lib\/prisma['"]/);
        expect(engine).not.toMatch(/from ['"]@\/app-layer\/repositories/);
        expect(driver).not.toMatch(/from ['"]@\/lib\/prisma['"]/);
        expect(driver).not.toMatch(/from ['"]@\/app-layer\/repositories/);
        // It DOES bind RLS per tenant (it's a usecase).
        expect(driver).toMatch(/runInTenantContext/);
    });
});

describe('Agentic engine — guardrails', () => {
    it('enforces per-run caps, composed with the agent policy card', () => {
        expect(types).toMatch(/MAX_STEPS/);
        expect(types).toMatch(/MAX_TOKENS/);
        expect(types).toMatch(/WALL_CLOCK_MS/);
        // The three engine ceilings are still declared exactly ONCE, in
        // `ENGINE_CAPS`, and DERIVED into the composed budget rather than
        // restated there — so `run-caps.ts` cannot drift from the engine's own
        // numbers. Bound to the declaration rather than grepped over the whole
        // file: `ENGINE_CAPS.MAX_STEPS` occurs twice in that module (the step
        // ceiling and the tool-call ceiling are deliberately the same number),
        // and a whole-file needle satisfied by either would go on passing with
        // the one it names deleted.
        const engineCeiling = declarationOf(runCaps, 'ENGINE_RUN_CAPS');
        expect(engineCeiling).toMatch(/ENGINE_CAPS\.MAX_STEPS/);
        expect(engineCeiling).toMatch(/ENGINE_CAPS\.MAX_TOKENS/);
        expect(engineCeiling).toMatch(/ENGINE_CAPS\.WALL_CLOCK_MS/);
        // The engine REACHES them through one budget rather than three inline
        // comparisons, so a fourth axis cannot be added without one.
        expect(driver).toMatch(/createRunBudget\(/);
        // A breach HALTS and says which cap fired — it never trims the work to
        // fit. The behaviour is tests/unit/agent-caps.test.ts; this only pins
        // that the halt path exists and is distinct from an ordinary failure.
        //
        // The DEFINITION moved to `run-settlement.ts` when a second engine
        // arrived, so it is asserted there and the driver is asserted to REACH
        // it. Both halves, deliberately: pinning only the definition would let
        // a driver quietly stop calling it, and pinning only the call site
        // would let the definition go while a same-named local took over.
        expect(settlement).toMatch(/export async function haltRunAtCap\(/);
        // Anchored on the IMPORT, which occurs once, rather than on
        // `haltRunAtCap(` — which occurs eight times in this file and is
        // therefore a Class D ambiguous needle: satisfied by any one of eight
        // sites, including the docstring that merely mentions it. The import
        // is also the stronger claim, since it pins that the driver reaches
        // the SHARED halt path rather than a same-named local.
        expect(driver).toMatch(/haltRunAtCap[^;]*from '\.\/run-settlement'/);
        expect(driver).toMatch(/failRun\(/);
    });

    it('the Flue engine is under the SAME budget, not a second one', () => {
        // The failure this exists for: an agentic loop is precisely the engine
        // that decides for itself how many tools to call and how long to keep
        // going, so a second driver that composed its own ceilings — or none —
        // would make `ENGINE_CAPS` a number that applies to the engine nobody
        // runs.
        expect(flueRun).toMatch(/createRunBudget\(/);
        expect(flueRun).toMatch(/resolveRunCaps\(/);
        // Charged on the axes an agentic loop can actually spend: a tool call
        // is its unit of work, and tokens are what a reasoning loop burns.
        expect(flueRun).toMatch(/'TOOL_CALLS'/);
        expect(flueRun).toMatch(/charge\('TOKENS'/);
        // And it halts through the shared path rather than settling its own
        // way, so a cap halt is the same row on both engines. Anchored on the
        // import for the reason above: the bare call needle matches five
        // sites here.
        expect(flueRun).toMatch(
            /haltRunAtCap[^;]*from '@\/lib\/agentic\/drivers\/run-settlement'/,
        );
        // Seeded from what earlier SEGMENTS spent. Without this a run with
        // three human checkpoints gets four budgets — the defect
        // `actionsAlready` and `proposedItemsSoFar` both exist to prevent.
        expect(flueRun).toMatch(/actionsAlready/);
        expect(flueRun).toMatch(/proposedItemsSoFar\(/);
    });

    it('abort works mid-run (the executor checks for ABORTED between steps)', () => {
        expect(driver).toMatch(/status === 'ABORTED'/);
        expect(engine).toMatch(/export async function abortWorkflowRun/);
    });

    it('every step audits with agent attribution', () => {
        // recordStep writes both a WorkflowStep row AND an audit entry. It
        // lives in the driver now, with the rest of the execution walk.
        //
        // BOUND with `functionBodyOf` rather than sliced from an `indexOf`.
        // The old form was `engine.slice(engine.indexOf('async function
        // recordStep'))`, and when the function moved out `indexOf` returned
        // -1, so the slice silently became the file's LAST CHARACTER and every
        // assertion below ran against it. A helper that throws on a missing
        // name reports that as a missing function, which is what it is.
        //
        // MOVED AGAIN, and the assertion follows it. `recordStep` came INTO
        // the driver with the #2719 extraction and has now moved OUT to
        // `drivers/step-recorder.ts`, because a second driver is coming and
        // the step ledger keeps exactly one write seam
        // (`tests/guards/workflow-step-single-write-seam.test.ts`). Asserting
        // against the driver would now pass only by finding nothing — which
        // is precisely what `functionBodyOf` refuses to let happen, and why
        // this reported a missing function rather than going quietly green.
        const recordBlock = functionBodyOf(recorder, 'recordStep');
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
        const mig = readSql('prisma/migrations/20260701150000_agentic_workflow_engine/migration.sql');
        for (const tbl of ['WorkflowRun', 'WorkflowStep']) {
            expect(mig).toMatch(new RegExp(`ALTER TABLE "${tbl}" FORCE ROW LEVEL SECURITY`));
            expect(mig).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON "${tbl}"`));
            expect(mig).toMatch(new RegExp(`CREATE POLICY superuser_bypass ON "${tbl}"`));
        }
    });
});

describe('Agentic engine — AISVS agentic-orchestration documented', () => {
    it('the implementation note records the composes-MCP-not-new-authority design', () => {
        // NARROWED, NOT MASKED (#2246). The read stays raw because these
        // assertions are about the note's PROSE — `mdCodeOf` keeps a
        // document's code and blanks the rest, so masking would delete the
        // subject. What was wrong was reading the WHOLE note for it: the
        // design claims were satisfied by any mention anywhere, including the
        // file list and the decision log. Measured over the note:
        // `/multi-step|orchestrat/i` 17 matches raw → 8 inside `## Design`,
        // `/propose-not-commit/i` 3 → 2. Bound to the sections that own them,
        // a design paragraph moved out of `## Design` reddens this.
        const note = readRaw('docs/implementation-notes/2026-07-01-agentic-workflow-engine.md');
        const design = mdSection(note, 'Design');
        expect(design).toMatch(/propose-not-commit/i);
        expect(design).toMatch(/multi-step|orchestrat/i);
        // The AISVS claim belongs to its own subsection — all 5 occurrences
        // of `/AISVS|C9/` in the note are already inside it, so this bound
        // loses nothing and pins where the applicability argument lives.
        expect(
            mdSection(note, 'AISVS C9 (Orchestration & Agentic Security)'),
        ).toMatch(/AISVS|C9/);
    });
});
