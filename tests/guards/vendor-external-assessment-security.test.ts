/**
 * Vendor external-assessment security ratchet.
 *
 * The public respondent path is the only place in the product where an
 * unauthenticated party writes to tenant-scoped tables. Five invariants
 * hold it closed. Each is a regression a plausible "tidy-up" PR would
 * reintroduce, and each was actually broken before this ratchet existed:
 *
 *   1. Post-verification reads/writes run inside a tenant context, so RLS
 *      engages. (`verifyAccessToken` itself must NOT — the public flow has
 *      no tenant at request time, which is exactly why everything after it
 *      must.)
 *   2. The writes carry explicit tenantId predicates.
 *   3. Respondent-supplied evidenceId is ownership-checked.
 *   4. Respondent free text is sanitised at persist, not at render.
 *   5. The public routes are edge-rate-limited, like every other anonymous
 *      surface.
 *
 * Plus the revocation gate, which is the operator's only way to kill a
 * leaked link in place.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RESPONSE = 'src/app-layer/usecases/vendor-assessment-response.ts';
const ACCESS = 'src/lib/security/external-assessment-access.ts';
const SEND = 'src/app-layer/usecases/vendor-assessment-send.ts';
const MIDDLEWARE = 'src/middleware.ts';

describe('1 — the public path runs under RLS', () => {
    const src = read(RESPONSE);

    it('imports the tenant-context helper', () => {
        // runInTenantContext, NOT raw withTenantDb — tests/unit/
        // no-direct-prisma.test.ts requires usecases to use the
        // RequestContext-shaped wrapper. withTenantDb is allowlisted only
        // for cross-tenant fan-out, which this single-tenant path is not.
        expect(src).toMatch(
            /import \{ runInTenantContext \} from '@\/lib\/db-context'/,
        );
        expect(src).not.toMatch(/withTenantDb\(/);
    });

    it('does not drive the answer write through a bare prisma transaction', () => {
        // The whole submit transaction used to be `prisma.$transaction`,
        // which runs as the owning role — RLS never engaged, and neither
        // write carried a tenantId predicate.
        //
        // Bounded to submitResponse itself. The post-commit notify helper
        // further down legitimately keeps a bare transaction: it writes an
        // outbox row with an explicit tenantId and reads a User, which is
        // not a tenant-scoped table. Its sibling call site in
        // vendor-assessment-review.ts does the same.
        const start = src.indexOf('export async function submitResponse');
        const end = src.indexOf('async function notifyAssessmentSubmitted');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const submitFn = src.slice(start, end);
        expect(submitFn).not.toMatch(/await prisma\.\$transaction/);
        expect(submitFn).toMatch(/runInTenantContext\(/);
    });

    it('loads the respondent payload inside a tenant context', () => {
        const loadFn = src.slice(
            src.indexOf('export async function loadResponseByToken'),
            src.indexOf('export async function submitResponse'),
        );
        expect(loadFn).toMatch(/runInTenantContext\(externalCtx/);
        // The reads moved onto the transaction client.
        expect(loadFn).not.toMatch(/prisma\.vendor\.findUnique/);
        expect(loadFn).not.toMatch(/prisma\.vendorAssessmentAnswer\.findMany/);
    });

    it('verifyAccessToken itself stays OUTSIDE a tenant context', () => {
        // Deliberate: the token lookup is what DISCOVERS the tenant. Wrapping
        // it would require knowing the tenant first, which is circular.
        //
        // Comments are stripped before matching — the module header
        // legitimately DISCUSSES runInTenantContext when explaining that
        // callers must use it.
        const code = read(ACCESS)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/withTenantDb\(|runInTenantContext\(/);
    });
});

describe('2 — the writes name their tenant', () => {
    const src = read(RESPONSE);

    it('the answer upsert carries a tenantId predicate', () => {
        expect(src).toMatch(
            /assessmentId_questionId: \{[\s\S]{0,160}?\},\s*\n\s*tenantId: assessment\.tenantId,/,
        );
    });

    it('the status transition carries a tenantId predicate', () => {
        expect(src).toMatch(
            /vendorAssessment\.update\(\{\s*\n?\s*where: \{ id: assessment\.id, tenantId: assessment\.tenantId \}/,
        );
    });
});

describe('3 — respondent-supplied evidenceId is ownership-checked', () => {
    const src = read(RESPONSE);

    it('looks the claimed ids up scoped to the assessment tenant', () => {
        expect(src).toMatch(/tdb\.evidence\.findMany\(/);
        expect(src).toMatch(/id: \{ in: claimedEvidenceIds \}/);
    });

    it('rejects rather than silently dropping an unowned reference', () => {
        expect(src).toMatch(/Unknown evidence reference/);
    });
});

describe('4 — respondent free text is sanitised at persist', () => {
    const src = read(RESPONSE);

    it('routes answerJson through the sanitiser before it is stored', () => {
        expect(src).toMatch(/import \{ sanitizePlainText \}/);
        expect(src).toMatch(/answerJson: sanitizeAnswerJson\(q, incoming\.answerJson\)/);
    });

    it('the sanitiser actually calls sanitizePlainText', () => {
        const fn = src.slice(src.indexOf('function sanitizeAnswerJson'));
        expect(fn).toMatch(/sanitizePlainText\(/);
    });
});

describe('5 — the public routes are edge-rate-limited', () => {
    const src = read(MIDDLEWARE);

    it('limits both the page and the API before the public-path allow', () => {
        const limitIdx = src.indexOf("'/api/vendor-assessment/'");
        const allowIdx = src.indexOf('if (isPublicPath(pathname))');
        expect(limitIdx).toBeGreaterThan(-1);
        // Ordering is the whole point: isPublicPath returns true for these
        // prefixes, so a limiter placed after it never runs.
        expect(limitIdx).toBeLessThan(allowIdx);
    });

    it('keys the bucket per assessment, not just per IP', () => {
        expect(src).toMatch(/vendorassess:\$\{assessmentId\}/);
    });
});

describe('6 — a leaked link can be revoked in place', () => {
    it('verifyAccessToken denies on revokedAt', () => {
        const access = read(ACCESS);
        expect(access).toMatch(/if \(assessment\.revokedAt\)/);
        expect(access).toMatch(/reason: 'revoked'/);
    });

    it('revocation is a distinct reason from expiry', () => {
        // Folding them together would lose the operator's signal that this
        // was a deliberate act rather than a link reaching its planned end.
        const access = read(ACCESS);
        expect(access).toMatch(/\|\s*'revoked'/);
    });

    it('a revoke usecase exists and is permission-gated', () => {
        const send = read(SEND);
        expect(send).toMatch(/export async function revokeAssessmentLink/);
        const fn = send.slice(send.indexOf('export async function revokeAssessmentLink'));
        expect(fn).toMatch(/assertCanRunAssessment\(ctx\)/);
        expect(fn).toMatch(/runInTenantContext\(/);
    });

    it('revoking does NOT rotate the token', () => {
        // The distinction from resend is the entire reason this exists: a
        // resend mints a fresh token, invalidating any link already shared.
        const send = read(SEND);
        const fn = send.slice(send.indexOf('export async function revokeAssessmentLink'));
        expect(fn).not.toMatch(/mintExternalAccessToken|randomBytes/);
    });
});

describe('7 — the anonymous respondent context claims no authority', () => {
    const src = read(RESPONSE);

    it('does not forge an EDITOR role with write permission', () => {
        const fn = src.slice(
            src.indexOf('function makeExternalAuditCtx'),
            src.indexOf('// ─── Types'),
        );
        expect(fn).not.toMatch(/role: 'EDITOR'/);
        expect(fn).not.toMatch(/canWrite: true/);
        expect(fn).not.toMatch(/canRead: true/);
    });
});

describe('8 — a required FILE_UPLOAD cannot be satisfied by emptiness', () => {
    it('the validator checks for content, not just field presence', () => {
        const src = read(RESPONSE);
        const arm = src.slice(
            src.indexOf("case 'FILE_UPLOAD'"),
            src.indexOf('function extractValue'),
        );
        expect(arm).toMatch(/q\.required/);
        expect(arm).toMatch(/requires an attachment or a note/);
    });
});
