/**
 * THE ANNOTATIONS AXIS, AT THE SEAM THAT GUARDS A CALL.
 *
 * #2941 gave `readOnlyHint` / `destructiveHint` / `idempotentHint` /
 * `openWorldHint` their own hash, so a server could not redeclare a read tool as
 * a write while producing an identical `manifestHash`. The hashing was right and
 * the catalogue used it correctly. The funnel did not.
 *
 * `assertToolManifestPinned` rebuilds a definition from the `McpReadTool` it is
 * about to run, and `McpReadTool` had no `annotations` field — so the live side
 * of the comparison was `hashToolManifest({... annotations: undefined})`, i.e.
 * the hash of `null`, for every tool, always. Against a pin the catalogue took
 * over the REAL hints that mismatched unconditionally:
 *
 *     descriptionHash  match          ✓
 *     schemaHash       match          ✓
 *     manifestHash     match          ✓
 *     annotationsHash  MISMATCH       ← a constant, not an observation
 *     → ANNOTATIONS_CHANGED, isSecurityEvent: true, mustRefuse: false
 *
 * Two consequences, and the second is the one that matters:
 *
 *   1. every external call reported that the far end had changed its hints,
 *      when nothing had;
 *   2. therefore a call where the far end GENUINELY flipped `readOnlyHint` was
 *      reported identically — the axis had no discriminating power at all at the
 *      one place a tool call is authorized.
 *
 * And it was silent, because `mustRefuse: false` had been implemented as an
 * early return ABOVE the recording, so the verdict reached no metric and no log.
 *
 * Measured 2026-09-27 against the pins the 2026-09-26 Entra proving run left on
 * file. The run succeeded throughout: the catalogue resolver verifies from the
 * live descriptor with annotations included and correctly returned APPROVED, so
 * the two seams disagreed about the same pin and only the quiet one was wrong.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf, functionBodyOf } from '../helpers/source-blocks';
import {
    hashToolManifest,
    verifyToolManifest,
    type ApprovedToolManifest,
    type ToolDefinition,
} from '@/lib/mcp/tool-manifest';

const ROOT = path.resolve(__dirname, '../..');

/** One of the three tools Microsoft's Entra MCP server actually advertises. */
const AS_ADVERTISED: ToolDefinition = {
    name: 'microsoft_graph_get',
    description: 'Execute a Microsoft Graph API call.',
    inputSchema: { type: 'object', properties: { relativeUrl: { type: 'string' } } },
    annotations: { readOnlyHint: true },
};

/** The pin the catalogue writes — over what the SERVER declared. */
const pinFor = (def: ToolDefinition): ApprovedToolManifest => {
    const h = hashToolManifest(def);
    return {
        toolName: `mcp__cmuibsj0c000001pgotomfidv__${def.name}`,
        descriptionHash: h.descriptionHash,
        schemaHash: h.schemaHash,
        manifestHash: h.manifestHash,
        annotationsHash: h.annotationsHash,
        revision: 1,
        approvedByUserId: 'usr_1',
        approvalSource: 'APPROVED',
    };
};

/** What the funnel now hands the verifier: the tool it is about to run. */
const asEnforced = (t: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
}): ToolDefinition => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
});

describe('a tool carrying its declared hints verifies against its own pin', () => {
    it('APPROVES — the normal case, which used to report drift', () => {
        const v = verifyToolManifest(asEnforced(AS_ADVERTISED), pinFor(AS_ADVERTISED));
        expect(v.status).toBe('APPROVED');
        expect(v.isSecurityEvent).toBe(false);
    });

    it('a tool that declares NOTHING also approves, so internal tools are untouched', () => {
        const bare = { ...AS_ADVERTISED, annotations: undefined };
        expect(verifyToolManifest(asEnforced(bare), pinFor(bare)).status).toBe('APPROVED');
    });

    it('dropping the hints on the way in reports drift — the defect, as a test', () => {
        // The shape that shipped: everything but `annotations`. Kept as an
        // assertion so the day it comes back, something fails.
        const { annotations: _dropped, ...withoutHints } = AS_ADVERTISED;
        const v = verifyToolManifest(withoutHints, pinFor(AS_ADVERTISED));
        expect(v.status).toBe('ANNOTATIONS_CHANGED');
        // …and every other axis agreed, which is why nobody looked here.
        expect(v.live.descriptionHash).toBe(v.approved?.descriptionHash);
        expect(v.live.schemaHash).toBe(v.approved?.schemaHash);
        expect(v.live.manifestHash).toBe(v.approved?.manifestHash);
    });
});

describe('the axis DISCRIMINATES, which is the property that was missing', () => {
    /** The event #2941 exists to catch: a read tool redeclared as a write. */
    const FLIPPED: ToolDefinition = {
        ...AS_ADVERTISED,
        annotations: { readOnlyHint: false },
    };

    it('a genuine readOnlyHint flip is ANNOTATIONS_CHANGED', () => {
        const v = verifyToolManifest(asEnforced(FLIPPED), pinFor(AS_ADVERTISED));
        expect(v.status).toBe('ANNOTATIONS_CHANGED');
        expect(v.isSecurityEvent).toBe(true);
    });

    it('and the unchanged tool is NOT — the two cases differ', () => {
        // This is the whole point. With the live side a constant these two
        // returned the SAME status, so the detector could not tell the event it
        // was built for from the absence of it. A probe with one answer for both
        // worlds is zero evidence wearing a measurement's costume.
        const unchanged = verifyToolManifest(asEnforced(AS_ADVERTISED), pinFor(AS_ADVERTISED));
        const flipped = verifyToolManifest(asEnforced(FLIPPED), pinFor(AS_ADVERTISED));
        expect(unchanged.status).not.toBe(flipped.status);
    });

    it('still does not REFUSE, because no dispatch reads the hint yet', () => {
        // Deliberate, and the line that changes when #2861's dispatch lands.
        expect(verifyToolManifest(asEnforced(FLIPPED), pinFor(AS_ADVERTISED)).mustRefuse).toBe(false);
    });
});

/**
 * THE CALL SITE, PINNED AT THE CALL SITE.
 *
 * Everything above passes with `assertToolManifestPinned` reverted — the
 * mechanism was never broken, only the definition handed to it. So this reads
 * the function that builds that definition, bounded to its body.
 */
describe('assertToolManifestPinned passes the declared hints through', () => {
    const body = functionBodyOf(
        codeOf(fs.readFileSync(path.join(ROOT, 'src/lib/mcp/authorize.ts'), 'utf8')),
        'assertToolManifestPinned',
    );

    it('the function body was actually found', () => {
        // Positive control: an empty body would make every assertion below pass
        // over nothing.
        expect(body.length).toBeGreaterThan(200);
        expect(body).toMatch(/verifyToolManifestForTenant/);
    });

    it('includes annotations in the definition it verifies', () => {
        expect(body).toMatch(/annotations:\s*tool\.annotations/);
    });

    it('records a security-event verdict instead of returning past it', () => {
        // The other half. `mustRefuse: false` must not mean "unobserved": the
        // early return sat above the recording, so the one verdict this axis
        // produces reached nothing. Both the counter and the log line are
        // asserted, because either alone leaves the finding half-delivered.
        expect(body).toMatch(/verdict\.isSecurityEvent/);
        const recordCalls = body.match(/recordToolManifestDrift\(/g) ?? [];
        // Twice: once on the non-refusing security path, once on the refusal.
        expect(recordCalls).toHaveLength(2);
        expect(body).toMatch(/liveAnnotationsHash/);
    });

    it('and the bare early return is gone', () => {
        // COUNTED rather than matched on the replacement: the broken form is an
        // absence, and asserting only that the new shape is present would stay
        // green if somebody added an unconditional `return` above it.
        expect(body).not.toMatch(/if \(!verdict\.mustRefuse\) return;/);
    });
});
