/**
 * Agent recertification writes in one place, and a campaign only NARROWS
 * (#3674).
 *
 * Three claims, each a different way the campaign could start meaning less
 * than it says:
 *
 *   1. The pack, narrowing and sample tables have ONE write seam —
 *      `usecases/access-review-agent.ts`. A pack is what a reviewer decided on
 *      and a narrowing is the record that a recertification changed an agent's
 *      authority; a second writer could put either there without the campaign
 *      rules (the owner may not decide, a pack is re-derived from its run's
 *      recorded read before it is stored) having run.
 *
 *   2. The campaign file can REMOVE authority and cannot ADD it. Its Prisma
 *      writes are an exact list of tables, none of which is the register, a
 *      grant or a card; it reaches the grant table only through
 *      `RegisteredAgentToolRepository.revokeGrant`, whose body is one
 *      `deleteMany`; and it imports none of the usecases that grant, raise a
 *      card or edit the register. Deleting a grant is the only effect a
 *      campaign has on an agent.
 *
 *   3. Pack preparation reads only. The pack workflow declares a READ step on a
 *      catalogued read tool and a SYNTHESIS step, and nothing else — no PROPOSE
 *      step, no checkpoint — and the evidence usecase behind the read tool
 *      writes nothing at all.
 *
 * Same detector shape as `agent-harness-single-write-seam.test.ts`: the
 * population comes from git, the detector never anchors on the client's name,
 * raw SQL is a second path, and an allowlisted seam that stops writing fails.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { braceBlockAfter, codeOf } from '../helpers/source-blocks';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { MCP_READ_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import {
    AGENT_RECERTIFICATION_EVIDENCE_TOOL,
    AGENT_RECERTIFICATION_PACK_WORKFLOW,
} from '@/lib/agentic/agent-recertification';

const CAMPAIGN = 'src/app-layer/usecases/access-review-agent.ts';
const EVIDENCE_READ = 'src/app-layer/usecases/agent-recertification-evidence.ts';
const GRANT_REPOSITORY = 'src/app-layer/repositories/RegisteredAgentToolRepository.ts';

/** Prisma delegate → its table. Each is written by `CAMPAIGN` alone. */
const SEAMS = {
    accessReviewAgentPack: 'AccessReviewAgentPack',
    accessReviewAgentNarrowing: 'AccessReviewAgentNarrowing',
    accessReviewDecisionSampleAudit: 'AccessReviewDecisionSampleAudit',
} as const;
type Delegate = keyof typeof SEAMS;

const WRITE_VERBS = 'create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany';
const RAW_METHOD_RE = /\$(?:executeRawUnsafe|executeRaw|queryRawUnsafe|queryRaw)/g;
const SQL_MUTATORS = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i;

/** The text of one raw statement, call or tagged-template form, bounded by its own delimiters. */
function rawStatementAfter(code: string, from: number): string {
    let i = from;
    while (i < code.length && /\s/.test(code[i])) i++;
    const open = code[i];
    if (open !== '(' && open !== '`') return '';
    if (open === '(') {
        let depth = 0;
        for (let j = i; j < code.length; j++) {
            if (code[j] === '(') depth++;
            else if (code[j] === ')' && --depth === 0) return code.slice(i, j + 1);
        }
        return code.slice(i);
    }
    for (let j = i + 1; j < code.length; j++) {
        if (code[j] === '\\') { j++; continue; }
        if (code[j] === '`') return code.slice(i, j + 1);
    }
    return code.slice(i);
}

/** Writes to the three seam tables, by delegate on any receiver or by raw SQL. */
export function findSeamWrites(code: string): Array<{ delegate: Delegate; detail: string }> {
    const out: Array<{ delegate: Delegate; detail: string }> = [];
    for (const delegate of Object.keys(SEAMS) as Delegate[]) {
        const re = new RegExp(`\\b${delegate}\\s*\\.\\s*(${WRITE_VERBS})\\s*\\(`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) out.push({ delegate, detail: `${delegate}.${m[1]}(` });
    }
    RAW_METHOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RAW_METHOD_RE.exec(code)) !== null) {
        const stmt = rawStatementAfter(code, m.index + m[0].length);
        if (!SQL_MUTATORS.test(stmt)) continue;
        for (const [delegate, table] of Object.entries(SEAMS) as [Delegate, string][]) {
            if (new RegExp(`["'\`\\s.]${table}["'\`\\s]`).test(stmt)) out.push({ delegate, detail: `${m[0]}(… ${table} …)` });
        }
    }
    return out;
}

/** Every Prisma delegate a file WRITES, as `delegate.verb`, on any receiver. */
export function delegateWrites(code: string): string[] {
    const re = new RegExp(`\\.\\s*([a-z][A-Za-z]*)\\s*\\.\\s*(${WRITE_VERBS})\\s*\\(`, 'g');
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) out.add(m[1]);
    return [...out].sort();
}

/** Static methods a file calls on a named class. */
function staticCalls(code: string, className: string): string[] {
    const re = new RegExp(`\\b${className}\\s*\\.\\s*([A-Za-z]\\w*)\\s*\\(`, 'g');
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) out.add(m[1]);
    return [...out].sort();
}

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => codeOf(readFileSync(path.join(ROOT, rel), 'utf8'));

describe('the recertification tables have one write seam', () => {
    const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });
    const scanned = files.map((abs) => ({ rel: repoRelative(abs), writes: findSeamWrites(codeOf(readFileSync(abs, 'utf8'))) }));

    it('scans the tree and finds exactly the campaign usecase writing', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(scanned.filter((s) => s.writes.length > 0).map((s) => s.rel)).toEqual([CAMPAIGN]);
    });

    it('the seam writes every one of its tables', () => {
        const writes = scanned.find((s) => s.rel === CAMPAIGN)?.writes ?? [];
        const dead = (Object.keys(SEAMS) as Delegate[]).filter((d) => !writes.some((w) => w.delegate === d));
        expect(dead).toEqual([]);
    });
});

describe('a campaign can delete a grant and cannot add authority', () => {
    const campaign = read(CAMPAIGN);

    it('writes exactly these tables — none of them the register, a grant or a card', () => {
        // A new entry here is a new effect of closing or deciding a campaign.
        // If it is `registeredAgent`, `registeredAgentTool` or
        // `agentPolicyCardVersion`, it is the effect this guard exists to stop.
        expect(delegateWrites(campaign)).toEqual([
            'accessReview',
            'accessReviewAgentNarrowing',
            'accessReviewAgentPack',
            'accessReviewConnectedDecision',
            'accessReviewDecisionSampleAudit',
            'evidence',
            'evidenceControlLink',
            'fileRecord',
            'task',
        ]);
    });

    it('reaches the grant table only through revokeGrant, which only deletes', () => {
        expect(staticCalls(campaign, 'RegisteredAgentToolRepository')).toEqual(['revokeGrant']);
        const body = braceBlockAfter(readFileSync(path.join(ROOT, GRANT_REPOSITORY), 'utf8'), 'static\\s+async\\s+revokeGrant\\s*\\(');
        expect(delegateWrites(body)).toEqual(['registeredAgentTool']);
        expect(body).toMatch(/\.registeredAgentTool\s*\.\s*deleteMany\s*\(/);
        expect(body).not.toMatch(/\.registeredAgentTool\s*\.\s*(?:create|createMany|update|updateMany|upsert)\s*\(/);
    });

    it('imports none of the usecases that grant, raise a card or edit the register', () => {
        const imports = [...campaign.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
        const authority = imports.filter((p) =>
            /registered-agent(?!.*evidence)|agent-policy-card|agent-tool-grant|agent-registry|agent-ownership/.test(p),
        );
        expect(authority).toEqual([]);
        expect(campaign).not.toMatch(/\b(?:grantAgentTool|grantRegisteredAgentTool|raiseAgentPolicyCard|createPolicyCardVersion|updateRegisteredAgent)\b/);
    });
});

describe('pack preparation reads only', () => {
    it('the pack workflow is one READ on a catalogued read tool and one SYNTHESIS', () => {
        const def = getWorkflowDefinition(AGENT_RECERTIFICATION_PACK_WORKFLOW);
        expect(def).toBeDefined();
        expect(def!.steps.map((s) => s.kind)).toEqual(['READ', 'SYNTHESIS']);
        const readStep = def!.steps[0] as { tool?: string };
        expect(readStep.tool).toBe(AGENT_RECERTIFICATION_EVIDENCE_TOOL);
        expect(MCP_READ_TOOL_NAMES).toContain(AGENT_RECERTIFICATION_EVIDENCE_TOOL);
    });

    it('the evidence usecase behind the read tool writes nothing', () => {
        const code = read(EVIDENCE_READ);
        expect(delegateWrites(code)).toEqual([]);
        expect(code).not.toMatch(/\$(?:executeRawUnsafe|executeRaw|queryRawUnsafe|queryRaw)\b/);
        expect(code).not.toMatch(/\blogEvent\s*\(|\bappendAuditEntry\s*\(/);
    });
});

describe('the detectors are not vacuous', () => {
    it('catches a delegate write on any receiver, and tells a table from its prefix', () => {
        expect(findSeamWrites('await tx.accessReviewAgentPack.updateMany({ data })').map((w) => w.detail)).toEqual([
            'accessReviewAgentPack.updateMany(',
        ]);
        expect(findSeamWrites('await db.accessReviewAgentPackage.create({})')).toEqual([]);
    });

    it('catches raw SQL and ignores a raw read', () => {
        expect(findSeamWrites('await prisma.$executeRawUnsafe(`UPDATE "AccessReviewAgentNarrowing" SET x = 1`)').map((w) => w.delegate)).toEqual([
            'accessReviewAgentNarrowing',
        ]);
        expect(findSeamWrites('await prisma.$queryRaw`SELECT * FROM "AccessReviewAgentNarrowing"`')).toEqual([]);
    });

    it('lists every delegate written, and none read', () => {
        expect(delegateWrites('db.registeredAgentTool.create({}); db.registeredAgent.findMany({})')).toEqual(['registeredAgentTool']);
        expect(delegateWrites(codeOf('// db.agentPolicyCardVersion.create({})\nconst x = 1;'))).toEqual([]);
    });
});
