/**
 * MCP TOOL ANNOTATIONS, PINNED ON THEIR OWN AXIS.
 *
 * `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` are
 * how a server declares whether a tool READS or WRITES. The client dropped them
 * at the boundary, so they were never hashed — and a server could redeclare a
 * read tool as a write one while producing an IDENTICAL `manifestHash`, leaving
 * `verifyToolManifest` reporting no drift at all.
 *
 * The whole external-write subsystem (#2861) turns on "is this tool a write?",
 * and MCP's declared answer to that was both discarded and unpinned.
 *
 * Two properties carry this change and both are asserted directly, because
 * getting either wrong is invisible afterwards:
 *
 *   1. adding the axis must NOT move `manifestHash` — otherwise every pin on
 *      file stops matching and every tool needs re-approval on deploy day.
 *   2. a NULL pinned hash must read as "never looked", never as agreement.
 */
import {
    hashToolManifest,
    verifyToolManifest,
    type ApprovedToolManifest,
    type ToolDefinition,
} from '@/lib/mcp/tool-manifest';

const BASE: ToolDefinition = {
    name: 'microsoft_graph_get',
    description: 'Execute a Microsoft Graph API call.',
    inputSchema: { type: 'object', properties: { relativeUrl: { type: 'string' } } },
};

const READ_ONLY = { ...BASE, annotations: { readOnlyHint: true, idempotentHint: true } };
/** The same tool, redeclared as a write. The event this change exists to catch. */
const FLIPPED = { ...BASE, annotations: { readOnlyHint: false, idempotentHint: true } };

const pinOf = (def: ToolDefinition, overrides: Partial<ApprovedToolManifest> = {}): ApprovedToolManifest => {
    const h = hashToolManifest(def);
    return {
        toolName: def.name,
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash,
        annotationsHash: h.annotationsHash,
        revision: 1,
        approvedByUserId: 'usr_1',
        approvalSource: 'APPROVED',
        ...overrides,
    };
};

describe('hashToolManifest — the annotations axis is independent', () => {
    it('does NOT move manifestHash, so every pin on file stays valid', () => {
        // The migration-safety property. If this ever fails, shipping the
        // change re-approves nothing and invalidates everything.
        expect(hashToolManifest(READ_ONLY).manifestHash).toBe(hashToolManifest(BASE).manifestHash);
        expect(hashToolManifest(FLIPPED).manifestHash).toBe(hashToolManifest(BASE).manifestHash);
    });

    it('DOES move annotationsHash when a hint flips', () => {
        // The positive control for the test above: if annotations changed no
        // hash at all, the first test would pass vacuously.
        expect(hashToolManifest(FLIPPED).annotationsHash).not.toBe(
            hashToolManifest(READ_ONLY).annotationsHash,
        );
    });

    it('hashes a tool with no annotations, rather than leaving it null', () => {
        // A tool that declares nothing is a fact worth attesting: pinning it
        // means a server that LATER starts declaring is caught.
        expect(hashToolManifest(BASE).annotationsHash).toEqual(expect.any(String));
    });

    it('tells "declared nothing" apart from "declared an empty object"', () => {
        const empty = { ...BASE, annotations: {} };
        expect(hashToolManifest(empty).annotationsHash).not.toBe(
            hashToolManifest(BASE).annotationsHash,
        );
    });

    it('is order-insensitive, because key order is not a change', () => {
        const a = { ...BASE, annotations: { readOnlyHint: true, openWorldHint: false } };
        const b = { ...BASE, annotations: { openWorldHint: false, readOnlyHint: true } };
        expect(hashToolManifest(a).annotationsHash).toBe(hashToolManifest(b).annotationsHash);
    });
});

describe('verifyToolManifest — what a flipped hint reports', () => {
    it('reports ANNOTATIONS_CHANGED when only the hints moved', () => {
        const v = verifyToolManifest(FLIPPED, pinOf(READ_ONLY));
        expect(v.status).toBe('ANNOTATIONS_CHANGED');
    });

    it('is a SECURITY EVENT — a read tool redeclared as a write is worth alerting on', () => {
        expect(verifyToolManifest(FLIPPED, pinOf(READ_ONLY)).isSecurityEvent).toBe(true);
    });

    it('does NOT refuse, because nothing reads the hint yet', () => {
        // Deliberate, and the line that changes when #2861's write path lands.
        // Refusing here would stop a tool whose name, description and schema
        // are all unchanged, to enforce a field no code consumes — a rung that
        // costs without protecting, which is what #2241 removed from the
        // identity ladder.
        expect(verifyToolManifest(FLIPPED, pinOf(READ_ONLY)).mustRefuse).toBe(false);
    });

    it('reports APPROVED when the hints agree', () => {
        expect(verifyToolManifest(READ_ONLY, pinOf(READ_ONLY)).status).toBe('APPROVED');
    });

    it('treats a pin from BEFORE the axis as unpinned, not as agreement', () => {
        // The second load-bearing property. A null must not be compared, or
        // every pre-existing pin reports drift the moment this ships.
        const old = pinOf(READ_ONLY, { annotationsHash: null });
        const v = verifyToolManifest(FLIPPED, old);
        expect(v.status).toBe('APPROVED');
        expect(v.isSecurityEvent).toBe(false);
        // …and the verdict still SAYS the axis is unpinned, so a surface can
        // tell "agreed" from "never looked".
        expect(v.approved?.annotationsHash).toBeNull();
    });

    it('treats an undefined annotationsHash the same as null', () => {
        const old = pinOf(READ_ONLY, { annotationsHash: undefined });
        expect(verifyToolManifest(FLIPPED, old).status).toBe('APPROVED');
    });

    it('lets a DEFINITION change win, because that one refuses', () => {
        // Both axes moved. The description drift is the more severe finding and
        // is the one that must be reported, because it is the one that refuses.
        const changed = { ...FLIPPED, description: 'Something else entirely.' };
        const v = verifyToolManifest(changed, pinOf(READ_ONLY));
        expect(v.status).toBe('DESCRIPTION_CHANGED');
        expect(v.mustRefuse).toBe(true);
    });

    it('still reports UNPINNED when there is no pin at all', () => {
        const v = verifyToolManifest(READ_ONLY, null);
        expect(v.status).toBe('UNPINNED');
        expect(v.approved).toBeNull();
        expect(v.live.annotationsHash).toEqual(expect.any(String));
    });
});
