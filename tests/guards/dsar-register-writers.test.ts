/**
 * The DSAR register (`DataSubjectRequest`) has exactly the writers named here.
 *
 * #5940 (owner decision 2026-11-25) gave the register its SECOND writer of
 * requests: the erasure completes the request it fulfils, and clears the
 * columns that could still name the person, from inside `eraseUser`'s own
 * transaction — because the admin writer (`dsar-register.ts`) reaches a request
 * only through the subject's ACTIVE membership, and an erasure requires every
 * membership removed first. A request is evidence that a rights request was
 * handled, so who can change one must have a short, written answer:
 *
 *   src/app-layer/usecases/dsar-register.ts        — the admin, in a tenant:
 *                                                    record and advance.
 *   src/app-layer/jobs/dsar-erasure-request.ts     — the system, inside the
 *                                                    erasure: complete the
 *                                                    request, clear notes and
 *                                                    export URL.
 *   src/lib/security/dsr-legacy-decrypt.ts         — a format repair, not a
 *                                                    writer of requests: it
 *                                                    rewrites values written
 *                                                    encrypted while the model
 *                                                    was in the manifest as the
 *                                                    same values in plaintext.
 *
 * A fourth file is a finding to fix, not an entry to add. The FK's
 * `ON DELETE SET NULL ("userId")` is the database's write and is not code.
 *
 * Both spellings of a write are read: a Prisma delegate call on
 * `dataSubjectRequest`, and raw SQL that inserts into, updates or deletes from
 * `"DataSubjectRequest"`. Comments are blanked first, so a sentence about a
 * write is not one.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { REPO_ROOT, repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf, functionBodyOf } from '../helpers/source-blocks';

const WRITERS = [
    'src/app-layer/jobs/dsar-erasure-request.ts',
    'src/app-layer/usecases/dsar-register.ts',
    'src/lib/security/dsr-legacy-decrypt.ts',
];

const DELEGATE_WRITE = /\bdataSubjectRequest\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/;
const RAW_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\\?"DataSubjectRequest\\?"/i;

function writesTheRegister(abs: string): boolean {
    const code = codeOf(readFileSync(abs, 'utf8'));
    return DELEGATE_WRITE.test(code) || RAW_WRITE.test(code);
}

const population = [...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }), ...repoFiles({ under: 'scripts', extensions: ['.ts'] })];

describe('the DSAR register has exactly its named writers (#5940)', () => {
    it('reads a real population', () => {
        expect(population.length).toBeGreaterThan(500);
    });

    it('only the named files write a DataSubjectRequest row', () => {
        const writers = population.filter(writesTheRegister).map(repoRelative).sort();
        expect(writers).toEqual(WRITERS);
    });

    it('the erasure writes the register only through fulfilErasureRequestWithin', () => {
        const src = readFileSync(path.join(REPO_ROOT, WRITERS[0]), 'utf8');
        const count = (text: string) => (text.match(new RegExp(DELEGATE_WRITE.source, 'g')) ?? []).length;
        const inFile = count(codeOf(src));
        expect(inFile).toBe(2);
        expect(count(functionBodyOf(src, 'fulfilErasureRequestWithin'))).toBe(inFile);
    });
});
