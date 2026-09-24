/**
 * A refusal described as clearable must be clearable.
 *
 * ── THE SHAPE OF THE DEFECT ─────────────────────────────────────────────────
 *
 * #2713 gave the joiner's entitlement map a SCHEMA and a READER:
 * `IdentityDepartmentGroupRule` for the per-department rules, and
 * `identityDefaultGroupId` / `identityDefaultGroupName` on
 * `TenantSecuritySettings` for the singular fallback. `identity-joiner-run`
 * reads the first with one `findMany`.
 *
 * It did not give either half a WRITER. No usecase creates, updates or deletes
 * a rule; `updateTenantSecurityConfig`'s patch type lists neither default-group
 * field. So no tenant can configure the map, every plan refuses
 * `NO_DEPARTMENT_MAP`, and `wouldCreate` is structurally 0.
 *
 * That is the sibling of the defect `agent-driver-column-has-a-writer` guards,
 * and this subsystem names it in its own words: *settable and inert, gated and
 * unsettable*. What made it expensive here was not the missing writer — that is
 * an unfinished feature, and unfinished is allowed. It was that FIVE docblocks
 * across four files said the opposite, in terms specific enough to be believed:
 * "that refusal is now one an operator CAN clear". A reader checking whether
 * the joiner was blocked would have read that sentence and stopped.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS A CONJUNCTION ───────────────────────────
 *
 * Not "a writer exists" — that would assert a feature nobody has committed to
 * building, and would fail for a reason the reader cannot act on.
 *
 * Instead: THE CODE AND THE COMMENTS AGREE. Either a write path exists and the
 * prose may say the refusal is clearable, or no write path exists and the prose
 * must not. Both states pass; only disagreement fails. So the day somebody
 * builds the write path, this test goes red and points at the five sentences
 * that need updating — which is the coupling that was missing.
 *
 * ── WHY TWO MASKERS ─────────────────────────────────────────────────────────
 *
 * The two halves are read through INVERSE masks, and it matters:
 *
 *   · `codeOf`      — blanks comments, keeps code. A comment *describing* a
 *                     write must never count as one, or the prose that caused
 *                     this defect would satisfy the guard that hunts it.
 *   · `commentsOf`  — keeps comments, blanks code. A string literal or an enum
 *                     member containing the word "clear" is not a claim.
 *
 * Reading both halves off the same unmasked text is how a guard ends up
 * agreeing with itself.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf, commentsOf } from '../helpers/source-blocks';

/**
 * `ROOT` computed LOCALLY — `assertion-reach.ts` constant-folds a
 * `path.resolve(__dirname, …)` and declines an identifier imported from another
 * module, which would put every assertion here in the Class D un-analysable set.
 */
const ROOT = path.resolve(__dirname, '../..');
const raw = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const SRC = repoRelativeFiles().filter(
    (f) => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.tsx')),
);

/** Prisma write verbs against the rules table, as CODE. */
const RULE_WRITE = /identityDepartmentGroupRule\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;

/**
 * The singular fallback's write path, checked PRECISELY rather than by pattern.
 *
 * A regex for `identityDefaultGroupId\s*:` cannot tell a write from a Prisma
 * `select: { identityDefaultGroupId: true }` — and `identity-joiner-run` has
 * exactly that select, so the pattern would report a write path that does not
 * exist and invert this entire guard. The honest signal is whether the patch
 * type an operator's edit actually flows through LISTS the field.
 */
const PATCH_TYPE = 'src/app-layer/usecases/tenant-security-settings.ts';
function defaultGroupIsSettable(): boolean {
    const code = codeOf(raw(PATCH_TYPE));
    const iface = code.slice(code.indexOf('interface TenantSecurityConfigPatch'));
    const body = iface.slice(0, iface.indexOf('}'));
    return /identityDefaultGroup(Id|Name)\s*\?/.test(body);
}

const writeSites = SRC.map((f) => ({ file: f, code: codeOf(raw(f)) })).filter(
    (s) => RULE_WRITE.test(s.code),
);

/**
 * The claim, in COMMENTS only. Deliberately narrow: it matches the specific
 * assertion that an operator can act, not every mention of the refusal.
 */
const CLAIM = /operator\s+(can|CAN)\s+clear|an operator can clear it/;

const claimSites = SRC.map((f) => ({ file: f, comments: commentsOf(raw(f)) })).filter((s) =>
    CLAIM.test(s.comments),
);

describe('the entitlement map — what the code does and what the comments say', () => {
    it('has a population to scan at all — an empty scan passes everything below', () => {
        // The denominator. Without it, a broken `repoRelativeFiles` or a typo in
        // the extension filter would make every assertion here vacuously true,
        // which is precisely how a guard reports health it never measured.
        expect(SRC.length).toBeGreaterThan(500);
        const mentions = SRC.filter((f) => raw(f).includes('identityDepartmentGroupRule'));
        expect(mentions.length).toBeGreaterThan(0);
    });

    it('the reader still exists — this guard is about a table the product USES', () => {
        // If the read went away the whole question changes, and this guard would
        // otherwise keep passing while guarding nothing.
        const readers = SRC.map((f) => codeOf(raw(f))).filter((c) =>
            /identityDepartmentGroupRule\s*\.\s*findMany/.test(c),
        );
        expect(readers.length).toBeGreaterThan(0);
    });

    it('CODE and COMMENTS agree about whether the refusal is clearable', () => {
        const hasWritePath = writeSites.length > 0 || defaultGroupIsSettable();

        if (hasWritePath) {
            // A write path landed. The prose is now allowed to say so — but
            // somebody must have gone and said it, because five docblocks
            // currently state the opposite.
            expect(claimSites.length).toBeGreaterThan(0);
        } else {
            // No write path. No comment may claim an operator can clear it.
            //
            // The diagnostic rides INSIDE the asserted value: jest's `expect`
            // takes one argument, and a second one is silently a TypeError
            // rather than a message — so a guard written the vitest way fails
            // for the wrong reason and names no file.
            expect({
                why:
                    'No write path exists for the entitlement map, so no comment may say an ' +
                    'operator can clear NO_DEPARTMENT_MAP. Build the write path, or correct ' +
                    'the prose (#2839).',
                offenders: claimSites.map((s) => s.file),
            }).toEqual({
                why: expect.any(String),
                offenders: [],
            });
        }
    });

    it('the masks are the right way round — proved, not assumed', () => {
        // The detector proof. A comment describing a write must NOT register as
        // a write, and code must NOT register as a claim. Without this, the two
        // scans could silently be reading the same text.
        const commentThatDescribesAWrite = '// we call identityDepartmentGroupRule.create() here\n';
        expect(RULE_WRITE.test(codeOf(commentThatDescribesAWrite))).toBe(false);

        const codeThatLooksLikeAClaim = 'const msg = "an operator can clear it";\n';
        expect(CLAIM.test(commentsOf(codeThatLooksLikeAClaim))).toBe(false);

        // ...and both masks still see their own half.
        expect(RULE_WRITE.test(codeOf('await db.identityDepartmentGroupRule.create({});\n'))).toBe(
            true,
        );
        expect(CLAIM.test(commentsOf('// an operator can clear it\n'))).toBe(true);
    });
});
