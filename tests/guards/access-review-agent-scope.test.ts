/**
 * Nothing writes the AGENT access-review scope yet (#3674, deploy 1 of 2).
 *
 * AGENT reaches `AccessReviewScope` in two deploys so that no running container
 * reads a value its Prisma client does not know — a client that meets an
 * unknown enum value fails the whole read, which on the register is every
 * campaign the tenant has. In THIS deploy the value exists, every reader handles
 * it, and nothing may create a campaign with it. Deploy 2 adds the one writer to
 * `WRITERS` below in its own pull request; until then the list is empty and its
 * emptiness is the property.
 *
 * What holds it, each checked here:
 *
 *   1. AccessReview has ONE create seam, `AccessReviewRepository.create` — no
 *      other file calls a create delegate on it or carries SQL text inserting
 *      into it — and no write anywhere sets `scope` after creation.
 *   2. That seam's `scope` parameter excludes AGENT, proved at the TYPE level
 *      below, so `npm run typecheck` fails if it is widened.
 *   3. No Zod schema is built from the generated `AccessReviewScope`. One was:
 *      `CreateAccessReviewSchema` used `z.nativeEnum(AccessReviewScope)`, which
 *      would have admitted AGENT the moment the client was regenerated, without
 *      any file naming it — the one way past check 4.
 *   4. Every access-review file whose CODE names AGENT is a listed reader with
 *      its reason, so a new one fails until somebody says whether it reads or
 *      writes.
 *   5. The scope list readers key on (`ACCESS_REVIEW_SCOPES`) is exactly the
 *      generated enum, proved at the type level, so a value added to the enum
 *      without a reader entry is a compile error, not a fall-through.
 *
 * The behaviour each reader gives AGENT is tested where it lives:
 * `tests/unit/access-review-agent-scope.test.ts`,
 * `tests/unit/access-review-close-route-dispatch.test.ts`,
 * `tests/rendered/access-review-agent-scope.test.tsx` and
 * `tests/integration/access-review-agent-scope.test.ts`.
 */
import { readFileSync } from 'fs';

import type { AccessReviewScope } from '@prisma/client';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { allCallExpressionsOf, codeOf } from '../helpers/source-blocks';
import type { AccessReviewRepository } from '@/app-layer/repositories/AccessReviewRepository';
import {
    ACCESS_REVIEW_SCOPES,
    AGENT_CAMPAIGNS_IMPLEMENTED,
    SUBJECT_TABLE,
    type StoredAccessReviewScope,
} from '@/lib/access-review/scope';

/** Access-review files that name AGENT to READ it, and why. */
const READERS: Readonly<Record<string, string>> = {
    'src/lib/access-review/scope.ts': 'declares the scope list, its subject table and the agent subject shape',
    'src/app-layer/usecases/access-review-scope-gate.ts': 'refuses to act on an AGENT campaign, by name',
    'src/app-layer/schemas/access-review.schemas.ts': 'refuses AGENT on the member creation route, by name',
    'src/app-layer/repositories/AccessReviewRepository.ts': 'excludes AGENT from the create seam by type and at run time',
    'src/app-layer/usecases/access-review.ts': 'narrows an AGENT campaign’s subjects to the reviewer or a register reader',
    'src/app-layer/usecases/access-review-connected.ts': 'narrows the subject list the same way; the remediation wording for an agent',
    'src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx': 'renders agent subjects, read-only while no AGENT campaign is implemented',
};

/** Files that may WRITE AGENT. Empty in deploy 1; deploy 2 adds the campaign usecase. */
const WRITERS: readonly string[] = [];

const CREATE_SEAM = 'src/app-layer/repositories/AccessReviewRepository.ts';

/** The quoted value, an enum member access, or an object key — not an identifier containing the word. */
export function namesAgent(code: string): boolean {
    return /(['"`])AGENT\1|\.AGENT\b|(?<![\w.$])AGENT\s*:/.test(code);
}

/** Is this file part of the access-review surface? */
export function touchesAccessReviews(rel: string, code: string): boolean {
    if (rel.includes('/access-reviews/') || rel.includes('/access-review')) return true;
    return /\baccessReview(?:ConnectedDecision|Decision)?\s*\.\s*\w+\s*\(|\bAccessReviewScope\b|@\/lib\/access-review\/|usecases\/access-review/.test(code);
}

/** Every create of an AccessReview row: a delegate on any receiver, or the SQL text. */
export function createsAccessReview(code: string): string[] {
    const out: string[] = [];
    const delegate = /\baccessReview\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = delegate.exec(code)) !== null) out.push(`accessReview.${m[1]}(`);
    const raw = /\bINSERT\s+INTO\s+(?:"public"\s*\.\s*)?"AccessReview"(?=[\s(]|$)/gi;
    while ((m = raw.exec(code)) !== null) out.push('raw INSERT INTO "AccessReview"');
    return out;
}

/** A write that sets `scope` on an existing row, by delegate or by SQL. */
export function rewritesScope(code: string): string[] {
    const out: string[] = [];
    for (const call of allCallExpressionsOf(code, 'accessReview\\s*\\.\\s*(?:update|updateMany|updateManyAndReturn|upsert)')) {
        if (/\bdata\s*:\s*\{[^}]*\bscope\s*:/.test(call)) out.push(call.slice(0, 60));
    }
    if (/\bUPDATE\s+(?:"public"\s*\.\s*)?"AccessReview"\s+SET\b[^;]*"scope"/i.test(code)) out.push('raw UPDATE "AccessReview" SET "scope"');
    return out;
}

/** A Zod schema built from the generated scope enum, however it is spelled. */
export function widensScopeSchema(code: string): boolean {
    return /\bz\s*\.\s*(?:nativeEnum|enum)\s*\(\s*(?:Object\s*\.\s*values\s*\(\s*)?(?:\$Enums\s*\.\s*|Prisma\s*\.\s*)?AccessReviewScope\b/.test(code);
}

describe('nothing writes the AGENT scope in deploy 1', () => {
    const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });
    const scanned = files.map((abs) => {
        const rel = repoRelative(abs);
        const code = codeOf(readFileSync(abs, 'utf8'));
        return {
            rel,
            surface: touchesAccessReviews(rel, code),
            names: namesAgent(code),
            creates: createsAccessReview(code),
            rewrites: rewritesScope(code),
            widens: widensScopeSchema(code),
        };
    });

    it('scans the tree, and the access-review surface within it', () => {
        expect(files.length).toBeGreaterThan(500);
        // Every listed reader must be on the surface the naming check reads,
        // or the check would pass by never looking at it.
        const surface = new Set(scanned.filter((s) => s.surface).map((s) => s.rel));
        expect(Object.keys(READERS).filter((r) => !surface.has(r))).toEqual([]);
        expect(surface.size).toBeGreaterThan(Object.keys(READERS).length);
    });

    it('AccessReview has one create seam', () => {
        expect(scanned.filter((s) => s.creates.length > 0).map((s) => s.rel)).toEqual([CREATE_SEAM]);
    });

    it('no write sets scope on an existing campaign', () => {
        expect(scanned.filter((s) => s.rewrites.length > 0).map((s) => `${s.rel}: ${s.rewrites.join(' | ')}`)).toEqual([]);
    });

    it('every access-review file that names AGENT is a listed reader or writer, and every listing is live', () => {
        const naming = scanned.filter((s) => s.surface && s.names).map((s) => s.rel).sort();
        expect(naming).toEqual([...Object.keys(READERS), ...WRITERS].sort());
    });

    it('no Zod schema is built from the generated scope enum', () => {
        expect(scanned.filter((s) => s.widens).map((s) => s.rel)).toEqual([]);
    });

    it('has no writer in this deploy, and the brake is on', () => {
        expect(WRITERS).toEqual([]);
        expect(AGENT_CAMPAIGNS_IMPLEMENTED).toBe(false);
    });
});

describe('the seam cannot store it, and readers cannot miss it, by type', () => {
    // Enforced by `npm run typecheck`, which covers tests/. Each `Proof` is
    // `never` when the property breaks, and the assignment below stops
    // compiling. The runtime assertions only keep the bindings used.
    type CreateScope = Parameters<typeof AccessReviewRepository.create>[2]['scope'];
    type CreateExcludesAgent = 'AGENT' extends CreateScope ? never : true;
    const createExcludesAgent: CreateExcludesAgent = true;

    // The readers' scope list is EXACTLY the generated enum, in both
    // directions: a value Prisma adds is a missing `SUBJECT_TABLE` key, and a
    // value the list invents is not a stored value.
    type EnumCoversList = StoredAccessReviewScope extends AccessReviewScope ? true : never;
    type ListCoversEnum = AccessReviewScope extends StoredAccessReviewScope ? true : never;
    const enumCoversList: EnumCoversList = true;
    const listCoversEnum: ListCoversEnum = true;

    it('AccessReviewRepository.create takes every scope but AGENT', () => {
        expect(createExcludesAgent).toBe(true);
    });

    it('ACCESS_REVIEW_SCOPES is the generated enum, and SUBJECT_TABLE is keyed on all of it', () => {
        expect(enumCoversList && listCoversEnum).toBe(true);
        expect(Object.keys(SUBJECT_TABLE).sort()).toEqual([...ACCESS_REVIEW_SCOPES].sort());
        expect(SUBJECT_TABLE.AGENT).toBe('CONNECTED');
    });
});

describe('the detectors are not vacuous', () => {
    it('names: the literal, an enum member and an object key, not an identifier containing the word', () => {
        expect(namesAgent(`scope === 'AGENT'`)).toBe(true);
        expect(namesAgent('AccessReviewScope.AGENT')).toBe(true);
        expect(namesAgent(`{ AGENT: 'CONNECTED' }`)).toBe(true);
        expect(namesAgent('AGENT_CAMPAIGN_REFUSAL')).toBe(false);
        expect(namesAgent('const x = AGENT_CAMPAIGNS_IMPLEMENTED;')).toBe(false);
    });

    it('surface: a delegate call, the enum type, the scope module, or a path under access-reviews', () => {
        expect(touchesAccessReviews('src/x.ts', 'await db.accessReview.findMany({})')).toBe(true);
        expect(touchesAccessReviews('src/x.ts', 'await tx.accessReviewConnectedDecision.updateMany({})')).toBe(true);
        expect(touchesAccessReviews('src/x.ts', "import type { AccessReviewScope } from '@prisma/client';")).toBe(true);
        expect(touchesAccessReviews('src/x.ts', "import { x } from '@/lib/access-review/scope';")).toBe(true);
        expect(touchesAccessReviews('src/app/t/[tenantSlug]/(app)/access-reviews/page.tsx', '')).toBe(true);
        expect(touchesAccessReviews('src/lib/agentic/kill-switch.ts', "scope: 'AGENT'")).toBe(false);
    });

    it('creates: a delegate on any receiver, and SQL text', () => {
        expect(createsAccessReview('await tx.accessReview.create({ data })')).toEqual(['accessReview.create(']);
        expect(createsAccessReview('db.accessReview.createMany({ data: rows })')).toEqual(['accessReview.createMany(']);
        expect(createsAccessReview('INSERT INTO "AccessReview" ("id") VALUES ($1)')).toEqual(['raw INSERT INTO "AccessReview"']);
        expect(createsAccessReview('INSERT INTO "AccessReviewDecision" ("id") VALUES ($1)')).toEqual([]);
        expect(createsAccessReview('db.accessReviewConnectedDecision.createMany({ data })')).toEqual([]);
    });

    it('rewrites: a scope in an update’s data, but not one in its where', () => {
        expect(rewritesScope("db.accessReview.updateMany({ where: { id }, data: { scope: 'AGENT' } })")).toHaveLength(1);
        expect(rewritesScope("db.accessReview.updateMany({ where: { id, scope: 'LEGACY_APP' }, data: { status: 'CLOSED' } })")).toEqual([]);
        expect(rewritesScope(`UPDATE "AccessReview" SET "scope" = 'AGENT'`)).toHaveLength(1);
    });

    it('widens: a Zod schema over the generated enum, however it is spelled', () => {
        expect(widensScopeSchema('z.nativeEnum(AccessReviewScope)')).toBe(true);
        expect(widensScopeSchema('z.enum(AccessReviewScope)')).toBe(true);
        expect(widensScopeSchema('z.enum(Object.values(AccessReviewScope) as [string])')).toBe(true);
        expect(widensScopeSchema('z.nativeEnum($Enums.AccessReviewScope)')).toBe(true);
        expect(widensScopeSchema('z.enum(MEMBER_ACCESS_REVIEW_SCOPES)')).toBe(false);
    });
});
