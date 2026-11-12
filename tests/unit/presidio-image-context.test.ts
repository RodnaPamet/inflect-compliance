/**
 * The PII detector image's build context is exactly what its Dockerfile COPYs.
 *
 * `guards/presidio/Dockerfile` is built from the repository root, and its test
 * stage reads the committed fixture corpus under `tests/`. The root
 * `.dockerignore` leaves `tests/` out of every build context, so without a
 * context of its own that COPY has nothing to copy and the image's pytest gate
 * never runs. `Dockerfile.dockerignore` beside it (which BuildKit reads in place
 * of the root file) is an allowlist: everything out, each COPY source back in.
 * This file holds the two lists to each other, both ways.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT } from '../helpers/repo-files';

const IMAGE = 'guards/presidio';
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Every source path a COPY in the Dockerfile reads from the build context. */
function copySources(): string[] {
    const sources: string[] = [];
    for (const line of read(`${IMAGE}/Dockerfile`).split('\n')) {
        const m = /^COPY\s+(.*)$/.exec(line.trim());
        if (!m) continue;
        const args = m[1].split(/\s+/);
        if (args.some((a) => a.startsWith('--from'))) continue;
        sources.push(...args.filter((a) => !a.startsWith('--')).slice(0, -1));
    }
    return sources;
}

function contextRules(): { first: string; allowed: string[] } {
    const rules = read(`${IMAGE}/Dockerfile.dockerignore`)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
    return { first: rules[0], allowed: rules.filter((r) => r.startsWith('!')).map((r) => r.slice(1)) };
}

describe('PII detector image build context', () => {
    it('reads the committed fixture corpus, which the root .dockerignore leaves out', () => {
        expect(copySources()).toEqual(expect.arrayContaining(['tests/fixtures/pii/corpus.json', 'tests/fixtures/pii/corpus.sha256']));
        const rootRules = read('.dockerignore').split('\n').map((l) => l.trim());
        expect(rootRules).toContain('tests/');
    });

    it('starts from nothing and lets back in exactly the paths the Dockerfile copies', () => {
        const { first, allowed } = contextRules();
        expect(first).toBe('*');
        expect([...allowed].sort()).toEqual([...new Set(copySources())].sort());
    });

    it('lets in only paths that exist, so a renamed source is caught here rather than at build', () => {
        const missing = contextRules().allowed.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
        expect(missing).toEqual([]);
    });
});
