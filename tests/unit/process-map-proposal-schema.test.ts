/**
 * The PROCESS_MAP proposal's payload contract (#5053): what an agent may put
 * in a proposed map, the canonical form it is stored in, and the one reader
 * the review diff and approval share.
 *
 * Every refusal names its path, so the test asserts WHICH rule refused rather
 * than only that something did.
 */
import {
    PROPOSED_PROCESS_MAP_MAX_EDGES,
    PROPOSED_PROCESS_MAP_MAX_NODES,
    ProposedProcessMapSchema,
    canonicaliseProposedProcessMap,
    readProposedProcessMap,
} from '@/lib/agentic/process-map-proposal';
import { PROCESS_MAP_TEMPLATES } from '@/components/processes/process-map-templates';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { hasInvisible } from '@/lib/text/invisible-chars';
import { PROPOSE_TOOLS } from '@/lib/mcp/tools/propose-tools';

function base(): Record<string, unknown> {
    return {
        name: 'Access review',
        description: 'Quarterly recertification',
        nodes: [
            { nodeKey: 'start', nodeType: 'processStep', label: 'Request' },
            { nodeKey: 'ok', nodeType: 'decision', label: 'Approved?' },
            { nodeKey: 'grant', label: 'Grant access', subtitle: 'Least privilege' },
        ],
        edges: [
            { sourceKey: 'start', targetKey: 'ok' },
            { sourceKey: 'ok', targetKey: 'grant', labelOverride: 'Yes' },
        ],
    };
}

/** The paths of every issue, joined, or `null` when the payload parses. */
function refusalPaths(payload: unknown): string[] | null {
    const r = ProposedProcessMapSchema.safeParse(payload);
    return r.success ? null : r.error.issues.map((i) => i.path.join('.'));
}

function withNode(i: number, patch: Record<string, unknown>): Record<string, unknown> {
    const p = base();
    const nodes = [...(p.nodes as Record<string, unknown>[])];
    nodes[i] = { ...nodes[i], ...patch };
    return { ...p, nodes };
}

function withEdge(i: number, patch: Record<string, unknown>): Record<string, unknown> {
    const p = base();
    const edges = [...(p.edges as Record<string, unknown>[])];
    edges[i] = { ...edges[i], ...patch };
    return { ...p, edges };
}

describe('ProposedProcessMapSchema — what is accepted', () => {
    it('accepts the base map and defaults a step to processStep', () => {
        const r = ProposedProcessMapSchema.safeParse(base());
        expect(r.success).toBe(true);
        expect(r.success && r.data.nodes[2].nodeType).toBe('processStep');
    });

    it('accepts a one-step map with no arrows', () => {
        expect(refusalPaths({ name: 'One', nodes: [{ nodeKey: 'a', label: 'Only step' }], edges: [] })).toBeNull();
    });

    it.each(PROCESS_MAP_TEMPLATES.map((t) => [t.id, t]))(
        'accepts the starter template %s with its positions and edge keys stripped',
        (_id, tpl) => {
            const payload = {
                name: tpl.defaultName,
                nodes: tpl.nodes.map(({ posX: _x, posY: _y, ...n }) => n),
                edges: tpl.edges.map(({ edgeKey: _k, ...e }) => e),
            };
            expect(refusalPaths(payload)).toBeNull();
        },
    );
});

describe('ProposedProcessMapSchema — what is refused, by path', () => {
    it.each([
        ['canvasMode', { canvasMode: 'AUTOMATION' }],
        ['status', { status: 'ACTIVE' }],
        ['freeformJson', { freeformJson: {} }],
    ])('refuses a top-level %s', (_name, extra) => {
        expect(refusalPaths({ ...base(), ...extra })).toEqual(['']);
    });

    it.each([
        ['posX', { posX: 10 }],
        ['parentNodeKey', { parentNodeKey: 'start' }],
        ['dataJson', { dataJson: { ruleId: 'r1' } }],
    ])('refuses a step carrying %s', (_name, patch) => {
        expect(refusalPaths(withNode(0, patch))).toEqual(['nodes.0']);
    });

    it.each(['action', 'agent', 'group'])('refuses the step type %s', (nodeType) => {
        expect(refusalPaths(withNode(0, { nodeType }))).toEqual(['nodes.0.nodeType']);
    });

    it('refuses a duplicate step key', () => {
        expect(refusalPaths(withNode(1, { nodeKey: 'start' }))).toContain('nodes.1.nodeKey');
    });

    it('refuses a step key carrying a slash', () => {
        expect(refusalPaths(withNode(0, { nodeKey: 'a/b' }))).toContain('nodes.0.nodeKey');
    });

    it('refuses zero steps and one step too many', () => {
        expect(refusalPaths({ ...base(), nodes: [], edges: [] })).toEqual(['nodes']);
        const many = Array.from({ length: PROPOSED_PROCESS_MAP_MAX_NODES + 1 }, (_, i) => ({
            nodeKey: `k${i}`,
            label: `Step ${i}`,
        }));
        expect(refusalPaths({ name: 'Big', nodes: many, edges: [] })).toEqual(['nodes']);
    });

    it.each([
        ['controls', { controls: [] }],
        ['edgeKind', { edgeKind: 'flow' }],
        ['edgeKey', { edgeKey: 'e1' }],
    ])('refuses an arrow carrying %s', (_name, patch) => {
        expect(refusalPaths(withEdge(0, patch))).toEqual(['edges.0']);
    });

    it('refuses an arrow to or from an unknown step', () => {
        expect(refusalPaths(withEdge(0, { sourceKey: 'nowhere' }))).toEqual(['edges.0.sourceKey']);
        expect(refusalPaths(withEdge(0, { targetKey: 'nowhere' }))).toEqual(['edges.0.targetKey']);
    });

    it('refuses a self-loop and a duplicate arrow', () => {
        expect(refusalPaths(withEdge(0, { targetKey: 'start' }))).toEqual(['edges.0']);
        expect(refusalPaths(withEdge(1, { sourceKey: 'start', targetKey: 'ok' }))).toEqual(['edges.1']);
    });

    it('refuses one arrow too many, and a missing arrow list', () => {
        const nodes = Array.from({ length: 10 }, (_, i) => ({ nodeKey: `k${i}`, label: `Step ${i}` }));
        const edges = [];
        for (let a = 0; a < 10 && edges.length <= PROPOSED_PROCESS_MAP_MAX_EDGES; a++) {
            for (let b = 0; b < 10 && edges.length <= PROPOSED_PROCESS_MAP_MAX_EDGES; b++) {
                if (a !== b) edges.push({ sourceKey: `k${a}`, targetKey: `k${b}` });
            }
        }
        expect(edges.length).toBe(PROPOSED_PROCESS_MAP_MAX_EDGES + 1);
        expect(refusalPaths({ name: 'Dense', nodes, edges })).toEqual(['edges']);
        const { edges: _gone, ...noEdges } = base();
        expect(refusalPaths(noEdges)).toEqual(['edges']);
    });

    it.each([
        ['201 characters', 'x'.repeat(201)],
        ['blank', '   '],
        ['a right-to-left override', 'Approve\u202Edeny'],
        ['a zero-width space', 'Appro\u200Bve'],
        ['a NUL', 'Appro\u0000ve'],
        ['a C1 control', 'Appro\u0085ve'],
        ['a soft hyphen', 'Appro\u00ADve'],
        ['a combining grapheme joiner', 'Appro\u034Fve'],
        ['an Arabic letter mark', 'Appro\u061Cve'],
        ['a Mongolian vowel separator', 'Appro\u180Eve'],
        ['a line separator', 'Appro\u2028ve'],
        ['a paragraph separator', 'Appro\u2029ve'],
        ['an invisible separator', 'Appro\u2063ve'],
    ])('refuses a label that is %s', (_name, label) => {
        expect(refusalPaths(withNode(0, { label }))).toEqual(['nodes.0.label']);
    });

    it('refuses every character the shared invisible-character check refuses', () => {
        // The shared class (src/lib/text/invisible-chars.ts); the schema's own
        // class must never admit one of these.
        for (const cp of [0x00ad, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff]) {
            const label = `Appro${String.fromCodePoint(cp)}ve`;
            expect(hasInvisible(label)).toBe(true);
            expect(refusalPaths(withNode(0, { label }))).toEqual(['nodes.0.label']);
        }
    });

    it('refuses an unsafe arrow label and an unsafe subtitle too', () => {
        expect(refusalPaths(withEdge(1, { labelOverride: 'Y\u202Ees' }))).toEqual(['edges.1.labelOverride']);
        expect(refusalPaths(withNode(2, { subtitle: 'a\u2066b' }))).toEqual(['nodes.2.subtitle']);
    });

    it.each([
        ['&shy;', 'a soft hyphen'],
        ['&#8232;', 'a line separator'],
        ['&#x200B;', 'a zero-width space'],
    ])('refuses an entity (%s) that sanitising decodes into %s (createAgentProposal re-parses)', (entity) => {
        const sanitised = sanitizePlainText(`Appro${entity}ve`);
        expect(sanitised).not.toBe(`Appro${entity}ve`);
        expect(refusalPaths(withNode(0, { label: sanitised }))).toEqual(['nodes.0.label']);
        expect(refusalPaths(withEdge(1, { labelOverride: sanitised }))).toEqual(['edges.1.labelOverride']);
    });

    it('a label that is only markup is refused once sanitised (createAgentProposal re-parses)', () => {
        const sanitised = withNode(0, { label: sanitizePlainText('<b></b>') });
        expect(refusalPaths(sanitised)).toEqual(['nodes.0.label']);
    });
});

describe('canonicaliseProposedProcessMap', () => {
    const parsed = () => ProposedProcessMapSchema.parse(base());

    it('re-mints the step keys n1..nN and rewrites the arrows, keeping none of the agent keys', () => {
        const c = canonicaliseProposedProcessMap(parsed());
        expect(c.nodes.map((n) => n.nodeKey)).toEqual(['n1', 'n2', 'n3']);
        expect(c.edges).toEqual([
            { sourceKey: 'n1', targetKey: 'n2' },
            { sourceKey: 'n2', targetKey: 'n3', labelOverride: 'Yes' },
        ]);
        expect(JSON.stringify(c)).not.toMatch(/"(start|ok|grant)"/);
    });

    it('is idempotent on its own output, which re-parses', () => {
        const once = canonicaliseProposedProcessMap(parsed());
        const twice = canonicaliseProposedProcessMap(ProposedProcessMapSchema.parse(once));
        expect(twice).toEqual(once);
    });

    it('drops empty optional text rather than storing an empty string', () => {
        const c = canonicaliseProposedProcessMap(
            ProposedProcessMapSchema.parse({ ...withNode(0, { subtitle: '  ' }), description: '' }),
        );
        expect('description' in c).toBe(false);
        expect('subtitle' in c.nodes[0]).toBe(false);
    });
});

describe('readProposedProcessMap — the reader review and approval share', () => {
    it('reads a canonical stored map', () => {
        const stored = canonicaliseProposedProcessMap(ProposedProcessMapSchema.parse(base()));
        const r = readProposedProcessMap(JSON.parse(JSON.stringify(stored)));
        expect(r).toEqual({ ok: true, map: stored });
    });

    it('refuses a payload that is not an object', () => {
        expect(readProposedProcessMap(null)).toEqual({ ok: false, reason: 'NOT_AN_OBJECT' });
        expect(readProposedProcessMap([base()])).toEqual({ ok: false, reason: 'NOT_AN_OBJECT' });
    });

    it('refuses a dangling arrow and zero steps', () => {
        expect(readProposedProcessMap(withEdge(0, { targetKey: 'gone' }))).toEqual({ ok: false, reason: 'INVALID' });
        expect(readProposedProcessMap({ name: 'x', nodes: [], edges: [] })).toEqual({ ok: false, reason: 'INVALID' });
    });

    it('refuses a well-formed map whose keys are not canonical', () => {
        expect(readProposedProcessMap(base())).toEqual({ ok: false, reason: 'NOT_CANONICAL' });
    });
});

/**
 * The tool's item schema is free-form, so its description is the model's only
 * source for the shape. A key format the description did not state refused a
 * whole map whose author used a natural key ("Step 1").
 */
describe('propose_process_map describes the step-key format the schema enforces', () => {
    const description = PROPOSE_TOOLS.find((t) => t.name === 'propose_process_map')!.description;
    const withKeys = (a: string, b: string) => ({
        name: 'Keys',
        nodes: [
            { nodeKey: a, label: 'First' },
            { nodeKey: b, label: 'Second' },
        ],
        edges: [{ sourceKey: a, targetKey: b }],
    });

    it('states the character set, the length and the uniqueness', () => {
        expect(description).toContain("letters, digits, '-' or '_' only, at most 40 characters");
        expect(description).toContain('each nodeKey unique');
    });

    it('the keys it gives as examples are accepted', () => {
        expect(refusalPaths(withKeys('review', 's1'))).toBeNull();
        expect(refusalPaths(withKeys('a'.repeat(40), 'b_-9'))).toBeNull();
    });

    it('the keys it warns against, and one past the length, are refused', () => {
        expect(description).toContain("never 'Step 1' or '1.1'");
        expect(refusalPaths(withKeys('Step 1', 's2'))).toContain('nodes.0.nodeKey');
        expect(refusalPaths(withKeys('1.1', 's2'))).toContain('nodes.0.nodeKey');
        expect(refusalPaths(withKeys('a'.repeat(41), 's2'))).toContain('nodes.0.nodeKey');
    });

    it('states the 200-character bound on the subtitle and the arrow label', () => {
        expect(description).toContain('subtitle (optional, max 200)');
        expect(description).toContain('labelOverride (optional, max 200)');
        expect(refusalPaths(withNode(0, { subtitle: 'x'.repeat(201) }))).toEqual(['nodes.0.subtitle']);
    });
});
