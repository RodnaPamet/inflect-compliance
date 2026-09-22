/**
 * THE RUNTIME'S DEFAULTS ARE TUNED FOR A STANDALONE SCRIPT, AND TWO OF THEM
 * ARE HAZARDS HERE.
 *
 * `start()` boots the Flue runtime in-process with no HTTP surface, which is
 * what makes an embedded driver possible. Its options carry three decisions
 * this product cannot take by default:
 *
 *   · `providers` OMITTED registers EVERY pi built-in — every vendor, each
 *     resolving its own ambient credential. With `aiResidency: LOCAL_ONLY` a
 *     hard invariant, that is an egress surface created by omission.
 *   · `db` defaults to in-memory, which is the answer we want — the temptation
 *     is to "fix" it, and any adapter is the second persistence path the
 *     integration plan refuses.
 *   · `agents` is fixed at start, so no run can assemble its own agent.
 *
 * These assertions are about the first two. The third is a property of the
 * runtime, recorded in the module's docstring rather than tested here, because
 * nothing in our code could violate it.
 */
import {
    flueProviderIdsFor,
    planFlueStart,
} from '@/lib/agentic/flue/runtime-bootstrap';
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import type { Provider } from '@earendil-works/pi-ai';

const fake = (id: string) => ({ id }) as unknown as Provider;

describe('which providers a deployment may register', () => {
    it('offers the local id when a gateway is configured', () => {
        expect(flueProviderIdsFor({ localBaseUrl: 'http://gw:11434/v1' })).toEqual([
            FLUE_PROVIDER_IDS.local,
        ]);
    });

    it('offers the external id when a credential exists', () => {
        expect(flueProviderIdsFor({ externalApiKey: 'sk-test' })).toEqual([
            FLUE_PROVIDER_IDS.external,
        ]);
    });

    it('offers BOTH when both are configured, local first', () => {
        // Order is not cosmetic: it is the order the ids are listed to an
        // operator, and the local one leading matches the residency
        // short-circuit reading order elsewhere.
        expect(
            flueProviderIdsFor({ localBaseUrl: 'http://gw:11434/v1', externalApiKey: 'sk' }),
        ).toEqual([FLUE_PROVIDER_IDS.local, FLUE_PROVIDER_IDS.external]);
    });

    it('offers NOTHING when neither is configured — and that is a real answer', () => {
        // Not a degenerate case to paper over. A deployment with no model
        // credentials registers no providers, and every run then refuses at
        // `resolveFlueModel` with a named reason. The alternative — falling
        // back to pi's built-ins — is how a vendor nobody chose ends up
        // serving a tenant's reasoning.
        expect(flueProviderIdsFor({})).toEqual([]);
        expect(flueProviderIdsFor({ externalApiKey: null, localBaseUrl: null })).toEqual([]);
    });
});

describe('the start plan never omits providers and never names a database', () => {
    it('carries the providers it was given', () => {
        const ps = [fake('a'), fake('b')];
        expect(planFlueStart(ps).providers).toBe(ps);
    });

    it('carries an EMPTY array rather than omitting the key', () => {
        // The distinction the runtime's own docstring draws: "Omitted
        // registers every pi built-in; an empty array registers none." An
        // absent key and an empty array are opposite instructions, and the
        // dangerous one is the shorter.
        const plan = planFlueStart([]);
        expect(Object.prototype.hasOwnProperty.call(plan, 'providers')).toBe(true);
        expect(plan.providers).toEqual([]);
    });

    it('names NO database, so the in-memory default stands', () => {
        // `db` absent, not `db: undefined`. A reader of the call site sees no
        // persistence decision to second-guess, and the type makes adding one
        // a compile error rather than a silent second write path.
        const plan = planFlueStart([fake('a')]);
        expect(Object.prototype.hasOwnProperty.call(plan, 'db')).toBe(false);
        expect(Object.keys(plan)).toEqual(['providers']);
    });
});
