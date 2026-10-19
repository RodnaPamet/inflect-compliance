/**
 * The scanner image's smoke check (#3686), run INSIDE the image by `smoke.sh`.
 *
 * It takes the report the image's dry run printed, on stdin, and the public
 * key the image's `public-key` command printed, as its argument, and verifies
 * the one through the other with the contract module the image itself ships:
 * the same `verifyAndParseHarnessReport` the ingest runs. So a pass says the
 * image signs a report the tenant's ingest would accept, from a key the tenant
 * would register, and that what it read of the smoke estate is in it.
 *
 * Prints one line per check and exits 1 when any fails. Not part of the image:
 * `smoke.sh` mounts it read-only for the one run.
 */
import { readFileSync } from 'fs';

import { HARNESS_CONTRACT_V2, verifyAndParseHarnessReport } from '@/lib/agentic/harness-contract';

import { SCANNER_VERSION, scannerManifestHash } from '../src/scanner-surface';

/** The agents `smoke.sh`'s estate defines, by the id the `code` source gives each, and a tool each binds. */
const EXPECTED_AGENTS: ReadonlyArray<readonly [discoveredId: string, tool: string]> = [
    ['code:estate/research/agent.ts#researchExecutor', 'search_papers'],
    ['code:estate/support/agent.py#support_executor', 'lookup_order'],
];

const results: Array<readonly [ok: boolean, what: string]> = [];
const check = (ok: boolean, what: string): void => {
    results.push([ok, what]);
};

const [publicKeyHex] = process.argv.slice(2);
const raw = readFileSync(0, 'utf8').trim();
const parsed = verifyAndParseHarnessReport(raw, publicKeyHex ? [publicKeyHex] : []);

check(parsed.ok, `the report verifies against the printed key${parsed.ok ? '' : ` (refused: ${parsed.reason})`}`);
if (parsed.ok) {
    const { body } = parsed;
    check(body.contract === HARNESS_CONTRACT_V2, `it speaks ${HARNESS_CONTRACT_V2}`);
    check(body.scan.scanner.version === SCANNER_VERSION, `it names scanner version ${SCANNER_VERSION}`);
    check(body.scan.scanner.manifestHash === scannerManifestHash(), 'it carries the scanner surface hash');
    check(
        body.population.sources.length === 1 &&
            body.population.sources[0].kind === 'code' &&
            body.population.sources[0].status === 'COMPLETE',
        'its one source, code, was read in full',
    );
    check(parsed.complete, 'the ingest would read it as a complete scan');
    for (const [discoveredId, tool] of EXPECTED_AGENTS) {
        const agent = body.agents.find((a) => a.discoveredId === discoveredId);
        check(agent !== undefined, `it reports ${discoveredId}`);
        check(agent?.tools.some((t) => t.name === tool) ?? false, `${discoveredId} binds ${tool}`);
    }
    check(body.agents.length === EXPECTED_AGENTS.length, `it reports ${EXPECTED_AGENTS.length} agents and no others`);
}

for (const [ok, what] of results) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
process.exit(results.every(([ok]) => ok) ? 0 : 1);
