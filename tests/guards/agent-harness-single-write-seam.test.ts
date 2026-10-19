/**
 * The harness tables have one write seam each (#3665).
 *
 * A scan is evidence that an agent population was inventoried and how far it
 * was read, and a level on a `DiscoveredAgent` is meant to be what the ladder
 * derived from verified verdicts. Both claims hold only while the verifying
 * usecase is the one thing that writes those rows: a second writer could put a
 * level on an agent that no signed report ever carried, and nothing reading the
 * row could tell. The same goes for the trusted keys (a second writer decides
 * whose reports count) and for acceptances (a second writer closes a shortfall
 * without its owner).
 *
 * Same shape as `directory-identity-tables-single-write-seam.test.ts`: the
 * population comes from git, the detector never anchors on the client's name,
 * raw SQL is a second path, and an allowlisted seam that stops writing fails.
 */
import { readFileSync } from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

/** Prisma delegate → its table, and the only file that may write it. */
const SEAMS = {
    agentHarnessScan: { table: 'AgentHarnessScan', seam: 'src/app-layer/usecases/agent-harness-scans.ts' },
    agentHarnessScanItem: { table: 'AgentHarnessScanItem', seam: 'src/app-layer/usecases/agent-harness-scans.ts' },
    discoveredAgent: { table: 'DiscoveredAgent', seam: 'src/app-layer/usecases/agent-harness-scans.ts' },
    agentHarnessScannerKey: { table: 'AgentHarnessScannerKey', seam: 'src/app-layer/usecases/agent-harness-scanner-keys.ts' },
    agentHarnessAcceptance: { table: 'AgentHarnessAcceptance', seam: 'src/app-layer/usecases/agent-harness-acceptance.ts' },
    // The estate declarations (#3678): which scanner covers which estate, at what
    // cadence and with whom accountable for each source. A second writer could
    // point an estate at a scanner that scans something else, and its health
    // would read fresh.
    agentHarnessEstate: { table: 'AgentHarnessEstate', seam: 'src/app-layer/usecases/agent-harness-estates.ts' },
    agentHarnessEstateSource: { table: 'AgentHarnessEstateSource', seam: 'src/app-layer/usecases/agent-harness-estates.ts' },
    // Not a harness table, held here because the rule is the same one (#3673):
    // the peer's card pin is the only thing that admits it, so exactly one file
    // may write the row that carries the pin.
    peerAgent: { table: 'PeerAgent', seam: 'src/app-layer/usecases/peer-agents.ts' },
} as const;
type Delegate = keyof typeof SEAMS;

const WRITE_VERBS = 'create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany';
const RAW_METHOD_RE = /\$(?:executeRawUnsafe|executeRaw|queryRawUnsafe|queryRaw)/g;
const SQL_MUTATORS = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i;

interface Write {
    delegate: Delegate;
    detail: string;
}

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

export function findWrites(code: string): Write[] {
    const out: Write[] = [];
    for (const delegate of Object.keys(SEAMS) as Delegate[]) {
        // `\b…\s*\.` so `agentHarnessScan` does not also match `agentHarnessScanItem`.
        const re = new RegExp(`\\b${delegate}\\s*\\.\\s*(${WRITE_VERBS})\\s*\\(`, 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) out.push({ delegate, detail: `${delegate}.${m[1]}(` });
    }
    RAW_METHOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RAW_METHOD_RE.exec(code)) !== null) {
        const stmt = rawStatementAfter(code, m.index + m[0].length);
        if (!SQL_MUTATORS.test(stmt)) continue;
        for (const [delegate, { table }] of Object.entries(SEAMS) as [Delegate, (typeof SEAMS)[Delegate]][]) {
            if (new RegExp(`["'\`\\s.]${table}["'\`\\s]`).test(stmt)) out.push({ delegate, detail: `${m[0]}(… ${table} …)` });
        }
    }
    return out;
}

describe('the harness tables have one write seam each', () => {
    const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });
    const scanned = files.map((abs) => ({ rel: repoRelative(abs), writes: findWrites(codeOf(readFileSync(abs, 'utf8'))) }));

    it('scans the tree and finds exactly the five seams writing', () => {
        expect(files.length).toBeGreaterThan(500);
        expect(scanned.filter((s) => s.writes.length > 0).map((s) => s.rel).sort()).toEqual([
            'src/app-layer/usecases/agent-harness-acceptance.ts',
            'src/app-layer/usecases/agent-harness-estates.ts',
            'src/app-layer/usecases/agent-harness-scanner-keys.ts',
            'src/app-layer/usecases/agent-harness-scans.ts',
            'src/app-layer/usecases/peer-agents.ts',
        ]);
    });

    it('no file outside its seam writes a harness table', () => {
        const trespassers = scanned.flatMap(({ rel, writes }) =>
            writes
                .filter((w) => SEAMS[w.delegate].seam !== rel)
                .map((w) => `${rel}: ${w.detail} — ${SEAMS[w.delegate].table} is written only by ${SEAMS[w.delegate].seam}`),
        );
        expect(trespassers).toEqual([]);
    });

    it('every seam actually writes its table', () => {
        const dead = (Object.keys(SEAMS) as Delegate[]).filter(
            (d) => !scanned.find((s) => s.rel === SEAMS[d].seam)?.writes.some((w) => w.delegate === d),
        );
        expect(dead).toEqual([]);
    });
});

describe('the detector is not vacuous', () => {
    it('catches a delegate write on any receiver, and tells a table from its prefix', () => {
        expect(findWrites('await tx.discoveredAgent.updateMany({ data })').map((w) => w.detail)).toEqual([
            'discoveredAgent.updateMany(',
        ]);
        expect(findWrites('await db.agentHarnessScanItem.createMany({ data })').map((w) => w.delegate)).toEqual([
            'agentHarnessScanItem',
        ]);
    });

    it('catches raw SQL in both call forms and ignores a raw read', () => {
        expect(findWrites('await prisma.$executeRawUnsafe(`UPDATE "DiscoveredAgent" SET x = 1`)').map((w) => w.delegate)).toEqual([
            'discoveredAgent',
        ]);
        expect(findWrites('await prisma.$queryRaw`DELETE FROM "AgentHarnessAcceptance"`').map((w) => w.delegate)).toEqual([
            'agentHarnessAcceptance',
        ]);
        expect(findWrites('await prisma.$queryRaw`SELECT * FROM "AgentHarnessScan"`')).toEqual([]);
    });

    it('does not read a comment as a write', () => {
        expect(findWrites(codeOf('// db.agentHarnessScan.create({})\nconst x = 1;'))).toEqual([]);
    });
});
