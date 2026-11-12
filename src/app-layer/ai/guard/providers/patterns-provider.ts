/**
 * AI Guard — the `patterns` provider: today's deterministic scanners, unchanged.
 *
 * Input goes to `scanInjection`, egress to `scanEgress`, and the scanner's own
 * `ScanResult` is returned as-is — the same object, not a copy — so a guard
 * composed of this provider alone is byte-identical to the guard before the
 * seam (`tests/unit/ai/guard-provider-seam.test.ts` holds that on a fixture
 * set). Free, local, auditable, and it cannot be talked out of a verdict; it is
 * always first in the provider list and is never switched off.
 */
import { scanInjection } from '../injection-scanner';
import { scanEgress } from '../egress-scanner';
import type { GuardProvider } from './types';

/**
 * The patterns provider's id. Its rule ids (`inj.*`, `egr.*`) predate the
 * seam and are recorded unprefixed; every other provider's are namespaced by
 * its id (see `compose.ts`).
 */
export const PATTERNS_PROVIDER_ID = 'patterns';

export const patternsProvider: GuardProvider = {
    id: PATTERNS_PROVIDER_ID,
    async scan(kind, content) {
        if (kind === 'input') {
            return scanInjection(typeof content === 'string' ? content : null);
        }
        return scanEgress(content);
    },
};
