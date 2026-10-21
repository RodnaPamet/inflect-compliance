/**
 * BOTH CARD VARIANTS AGAINST THE A2A v0.3.0 SCHEMA ITSELF (#3862).
 *
 * The schema is the vendored spec at tag `v0.3.0` — see
 * `tests/fixtures/a2a/PROVENANCE.md`, which records the blob sha so "unmodified
 * upstream bytes" is checkable rather than asserted. The card declares
 * `protocolVersion: '0.3.0'`, so this is the version it must satisfy.
 *
 * Two things are proved here that a hand-written expectation could not:
 *
 *  1. The HOST card conforms. The prompt for this issue listed the skill fields
 *     as "id, name, description, examples" — the spec also REQUIRES `tags`
 *     (`AgentSkill.required` is `["description","id","name","tags"]`), so a card
 *     built to that list alone would have failed right here. It is the reason
 *     to validate against the spec rather than against a reading of it.
 *
 *  2. The PEER card conforms too, unchanged. Nothing asserted that before, and
 *     it matters: `x-inflect` and `x-inflect-signature` are extension members,
 *     legal only because `AgentCard` sets no `additionalProperties: false`. If a
 *     future protocol version closes the card, this test says so.
 *
 * The validator is `tests/helpers/json-schema-subset.ts`, which implements nine
 * keywords and PUBLISHES that list, because the failure mode of a small
 * validator is being blind rather than wrong — and a blind validator passes
 * everything. The vocabulary test below is what keeps it honest.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { a2aSigningKeyFromSeed, mintA2aSigningSeed } from '@/lib/agentic/a2a/signing-key';
import {
    buildInflectAgentCard,
    buildInflectHostConsumerCard,
    signInflectAgentCard,
} from '@/lib/agentic/a2a/own-card';
import { advertisedA2aSkills } from '@/lib/agentic/a2a/host-card-skills';
import {
    IMPLEMENTED_KEYWORDS,
    collectKeywords,
    validateAgainstDefinition,
    type SchemaNode,
} from '../helpers/json-schema-subset';

const SPEC: SchemaNode = JSON.parse(
    readFileSync(path.resolve(__dirname, '../fixtures/a2a/a2a-spec-v0.3.0.json'), 'utf8'),
) as SchemaNode;

const ORIGIN = 'https://app.inflect.test';
const NOW = new Date('2026-10-20T12:00:00Z');

function key() {
    const k = a2aSigningKeyFromSeed(mintA2aSigningSeed());
    if (!k) throw new Error('no key');
    return k;
}

function cards() {
    const current = key();
    const input = {
        origin: ORIGIN,
        tenantSlug: 'acme',
        current: { publicKeyHex: current.publicKeyHex, fingerprint: current.fingerprint },
        previous: null,
        now: NOW,
    };
    return {
        peer: signInflectAgentCard(buildInflectAgentCard(input), current),
        host: signInflectAgentCard(
            buildInflectHostConsumerCard({ ...input, skills: advertisedA2aSkills() }),
            current,
        ),
    };
}

/** JSON round-trip: what a client actually receives, with `undefined` gone. */
const wire = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('the A2A v0.3.0 schema is the one we are checked against', () => {
    it('exposes AgentCard and AgentSkill, so the fixture is the spec and not something else', () => {
        const defs = SPEC['definitions'] as Record<string, SchemaNode>;
        expect(Object.keys(defs)).toContain('AgentCard');
        expect(Object.keys(defs)).toContain('AgentSkill');
        // The spec's own requirement list, quoted by asserting it.
        expect((defs['AgentSkill'] as { required: string[] }).required.slice().sort()).toEqual([
            'description',
            'id',
            'name',
            'tags',
        ]);
    });

    it('uses no JSON Schema keyword the validator does not implement', () => {
        // THE ANTI-BLINDNESS CHECK. If a refreshed spec introduces `oneOf`,
        // `minItems`, `pattern` or anything else, this fails here instead of the
        // card silently ceasing to be validated.
        const used = collectKeywords(SPEC, 'AgentCard');
        const unimplemented = [...used].filter((k) => !(IMPLEMENTED_KEYWORDS as readonly string[]).includes(k));
        expect(unimplemented).toEqual([]);
    });
});

describe('both card variants conform to AgentCard', () => {
    it('the HOST-CONSUMER card conforms', () => {
        expect(validateAgainstDefinition(SPEC, 'AgentCard', wire(cards().host))).toEqual([]);
    });

    it('the PEER card conforms, and so extension members are legal', () => {
        expect(validateAgainstDefinition(SPEC, 'AgentCard', wire(cards().peer))).toEqual([]);
    });

    it('the host card advertises at least one skill, or this suite proves nothing about skills', () => {
        // A DENOMINATOR. Every assertion below about skills would pass vacuously
        // against an empty array, so the population is asserted first.
        expect(cards().host.skills.length).toBeGreaterThan(0);
    });

    it('every advertised skill conforms to AgentSkill on its own', () => {
        const skills = wire(cards().host.skills) as unknown[];
        for (const skill of skills) {
            expect(validateAgainstDefinition(SPEC, 'AgentSkill', skill)).toEqual([]);
        }
    });
});

/**
 * MUTATION PROOFS. A validator that cannot fail is green forever, so each of
 * these breaks the card in one specific way the spec forbids and asserts the
 * violation is reported. Remove the corresponding check from the validator and
 * exactly one of these goes red.
 */
describe('the validator can actually fail', () => {
    const base = () => wire(cards().host) as Record<string, unknown>;

    it('catches a skill with no tags — the member the issue prompt omitted', () => {
        const card = base();
        const skills = card['skills'] as Array<Record<string, unknown>>;
        delete skills[0]['tags'];
        const found = validateAgainstDefinition(SPEC, 'AgentCard', card);
        expect(found).toEqual([expect.objectContaining({ path: 'skills[0].tags' })]);
    });

    it('catches a missing top-level required member', () => {
        const card = base();
        delete card['protocolVersion'];
        expect(validateAgainstDefinition(SPEC, 'AgentCard', card)).toEqual([
            expect.objectContaining({ path: 'protocolVersion', message: 'required member missing' }),
        ]);
    });

    it('catches the wrong type where the spec says string', () => {
        const card = base();
        card['name'] = 42;
        expect(validateAgainstDefinition(SPEC, 'AgentCard', card)).toEqual([
            expect.objectContaining({ path: 'name' }),
        ]);
    });

    it('catches a security scheme that is not one of the spec’s kinds', () => {
        const card = base();
        // `type: 'oauth2'` is a `const` in the spec, and SecurityScheme is an
        // anyOf over the five kinds — so a bogus type matches no branch.
        card['securitySchemes'] = { hostConsumerOAuth2: { type: 'magic', flows: {} } };
        const found = validateAgainstDefinition(SPEC, 'AgentCard', card);
        expect(found.length).toBeGreaterThan(0);
    });

    it('catches skills that are not an array', () => {
        const card = base();
        card['skills'] = { id: 'posture-review' };
        expect(validateAgainstDefinition(SPEC, 'AgentCard', card)).toEqual([
            expect.objectContaining({ path: 'skills' }),
        ]);
    });

    it('reports nothing for the unmutated card, so the proofs above are not false alarms', () => {
        // The positive control: the same helper, the same path, no mutation.
        expect(validateAgainstDefinition(SPEC, 'AgentCard', base())).toEqual([]);
    });
});
