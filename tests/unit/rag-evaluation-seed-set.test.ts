/**
 * The seed RAG evaluation set is grounded in what the seed actually loads
 * (Ragas roadmap Phase 0, docs/ai-architecture/ragas.md).
 *
 * A set whose ground truth is not in the corpus measures the judge's
 * imagination, not the retriever. So every ground-truth passage must be a
 * verbatim substring of the policy text `prisma/seed.ts` publishes into the
 * seed tenant, the hash file must name this exact content, and the cases that
 * must NOT be answerable from the corpus must stay that way.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { checkRagEvaluationSet, type RagEvaluationSet } from '@/lib/ai/evals/rag-record';

const ROOT = path.join(__dirname, '..', '..');
const SET_FILE = path.join(ROOT, 'evals/rag/sets/seed-policies.json');

interface Template { title: string; contentText: string }
function templates(fixture: string): Template[] {
    return (JSON.parse(fs.readFileSync(path.join(ROOT, 'prisma/fixtures', fixture), 'utf8')) as { templates: Template[] }).templates;
}

/** The seed's own slug rule for a seeded policy (prisma/seed.ts, the Policies block). */
const seedSlug = (title: string) => title.replace(/\s+/g, '-').toLowerCase();

/** The titles the seed publishes as tenant policies: the `toSeed` array literal, read bounded. */
function seededPolicyTitles(): string[] {
    const seed = fs.readFileSync(path.join(ROOT, 'prisma/seed.ts'), 'utf8');
    const block = /const toSeed = \[([^\]]*)\];/.exec(seed);
    if (!block) throw new Error('prisma/seed.ts no longer declares `const toSeed = [...]`; re-derive the corpus');
    return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * The seed tenant's policy text, keyed by slug. The imported fixture is the
 * LAST writer of these titles (it upserts by title over the ciso-toolkit and
 * hand-written copies), so its text is what a seeded policy version holds.
 */
function seedCorpus(): Map<string, string> {
    const imported = templates('policy-templates-imported.json');
    const corpus = new Map<string, string>();
    for (const title of seededPolicyTitles()) {
        const t = imported.find((x) => x.title === title);
        if (!t) throw new Error(`seeded policy "${title}" is not in the imported fixture; re-derive the corpus`);
        corpus.set(seedSlug(title), t.contentText);
    }
    return corpus;
}

function loadSet(): RagEvaluationSet {
    const check = checkRagEvaluationSet(JSON.parse(fs.readFileSync(SET_FILE, 'utf8')));
    if (!check.ok) throw new Error(`${check.reason}: ${check.detail}`);
    return check.set;
}

describe('the seed RAG evaluation set', () => {
    const set = loadSet();
    const corpus = seedCorpus();

    it('parses under the strict schema, holding every case kind', () => {
        expect(new Set(set.cases.map((c) => c.kind))).toEqual(new Set(['task', 'refusal', 'injection', 'missing-input']));
        expect(set.provenance).toBe('authored');
    });

    it('is the content its hash file names', () => {
        const check = checkRagEvaluationSet(set);
        if (!check.ok) throw new Error(check.detail);
        expect(fs.readFileSync(`${SET_FILE}.sha256`, 'utf8').trim()).toBe(check.hash);
    });

    it('rests every ground-truth passage, verbatim, on a policy the seed publishes', () => {
        const ungrounded: string[] = [];
        for (const c of set.cases) {
            for (const ref of c.groundTruth.refs) {
                const text = corpus.get(ref.sourceKey);
                if (text === undefined || !text.includes(ref.passage)) ungrounded.push(`${c.id} → ${ref.sourceKey}`);
            }
        }
        expect(ungrounded).toEqual([]);
    });

    it('reads the seed policies from the fixture that writes them last', () => {
        // The gap-fill fixture is applied after the imported one; if it ever
        // carried one of these titles it would overwrite the text the set rests on.
        const later = new Set(templates('policy-templates-original-gaps.json').map((t) => t.title));
        expect(seededPolicyTitles().filter((t) => later.has(t))).toEqual([]);
    });

    it('never lets an injected chunk pose as a seeded policy, nor its markers occur in the corpus', () => {
        const all = [...corpus.values()].join('\n').toLowerCase();
        const clashes: string[] = [];
        for (const c of set.cases.filter((x) => x.kind === 'injection')) {
            if (c.injected && corpus.has(c.injected.sourceKey)) clashes.push(`${c.id}: key ${c.injected.sourceKey}`);
            for (const f of c.forbidden ?? []) if (all.includes(f.toLowerCase())) clashes.push(`${c.id}: marker ${f}`);
        }
        expect(clashes).toEqual([]);
    });

    it('asks each missing-input case for a document the seed does not publish', () => {
        const titles = new Set(seededPolicyTitles().map((t) => t.toLowerCase()));
        const present = set.cases
            .filter((c) => c.kind === 'missing-input')
            .filter((c) => titles.has((c.missingDocument ?? '').toLowerCase()))
            .map((c) => c.id);
        expect(present).toEqual([]);
    });
});
