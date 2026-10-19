/**
 * The scanner's configuration and its schedule (#3678).
 *
 *   1. A configuration is strict and credential-free: secrets are named by
 *      environment variable, a pasted credential is refused by path, and every
 *      host is fixed by its kind.
 *   2. Three fixture estates each carry a schedule, and the loop keeps to it —
 *      including after a run that failed.
 */
import { CLIENT_ESTATES } from '../../helpers/agent-harness-estate-fixtures';
import { ConfigError, credentialEnvNames, parseScannerConfig } from '../../../packages/agent-harness-scanner/src/config';
import { jsonLineLog } from '../../../packages/agent-harness-scanner/src/log';
import { runOnSchedule } from '../../../packages/agent-harness-scanner/src/schedule';

const base = () => structuredClone(CLIENT_ESTATES[0].scannerConfig) as Record<string, unknown>;

function refusal(json: unknown): string {
    try {
        parseScannerConfig(json);
    } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as Error).message;
    }
    throw new Error('expected a refusal');
}

describe('1. a strict, credential-free configuration', () => {
    it('names every credential by its environment variable, and applies the defaults', () => {
        const config = parseScannerConfig(base());
        expect(credentialEnvNames(config)).toEqual([
            'SCANNER_SIGNING_KEY',
            'INFLECT_INGEST_KEY',
            'ACME_OKTA_API_TOKEN',
            'ACME_AZURE_CLIENT_SECRET',
        ]);
        expect(config.timeBoxSeconds).toBe(600);
        expect(config.sources[0]).toMatchObject({ kind: 'okta-app', ownerProfileKey: 'owner' });
        expect(config.sources[1]).toMatchObject({ kind: 'vault', principalTag: 'inflect-principal', ownerTag: 'owner' });
    });

    it('refuses a credential pasted anywhere, by path and never by value', () => {
        const c = base();
        const pasted = ['gh', 'p_', 'Z'.repeat(36)].join('');
        (c.inflect as Record<string, unknown>).apiKeyEnv = pasted;
        const message = refusal(c);
        expect(message).toContain('inflect.apiKeyEnv');
        expect(message).not.toContain(pasted);
    });

    it('refuses a field it does not define — there is no field for a write credential, or any credential', () => {
        const c = base();
        (c.sources as Record<string, unknown>[])[0].apiToken = 'value';
        expect(refusal(c)).toContain('sources.0');
    });

    it.each([
        ['an Okta org off Okta\'s domains', (c: Record<string, unknown>) => ((c.sources as Record<string, unknown>[])[0].orgUrl = 'https://okta.evil.example')],
        ['an http Okta org', (c: Record<string, unknown>) => ((c.sources as Record<string, unknown>[])[0].orgUrl = 'http://acme.okta.com')],
        ['a vault on another cloud', (c: Record<string, unknown>) => ((c.sources as Record<string, unknown>[])[1].vaultUrls = ['https://acme.vault.azure.cn'])],
        ['a vault URL with a path', (c: Record<string, unknown>) => ((c.sources as Record<string, unknown>[])[1].vaultUrls = ['https://acme.vault.azure.net/secrets'])],
        ['an http ingest', (c: Record<string, unknown>) => ((c.inflect as Record<string, unknown>).baseUrl = 'http://inflect.example.com')],
        ['a second vault product', (c: Record<string, unknown>) => ((c.sources as Record<string, unknown>[])[1].product = 'hashicorp-vault')],
        ['the same kind twice', (c: Record<string, unknown>) => (c.sources as unknown[]).push((c.sources as unknown[])[0])],
        ['no sources at all', (c: Record<string, unknown>) => (c.sources = [])],
    ])('refuses %s', (_label, edit) => {
        const c = base();
        edit(c);
        expect(() => parseScannerConfig(c)).toThrow(ConfigError);
    });
});

describe('2. three estates, each on a schedule', () => {
    it('every fixture estate parses, with a schedule and a source per declared kind', () => {
        expect(CLIENT_ESTATES).toHaveLength(3);
        for (const estate of CLIENT_ESTATES) {
            const config = parseScannerConfig(estate.scannerConfig);
            expect(config.schedule.everyHours).toBe(estate.cadenceHours);
            expect(config.sources.map((s) => s.kind).sort()).toEqual(estate.sources.map((s) => s.kind).sort());
        }
    });

    it('runs at the cadence, anchored to each start, and carries on after a failed run', async () => {
        let t = 0;
        const starts: number[] = [];
        const lines: string[] = [];
        let call = 0;
        const runs = await runOnSchedule({
            everyHours: 24,
            log: jsonLineLog((l) => lines.push(l)),
            now: () => t,
            sleep: async (ms) => {
                t += ms;
            },
            maxRuns: 3,
            run: async () => {
                starts.push(t);
                call += 1;
                t += 30 * 60_000; // each scan takes half an hour
                if (call === 2) throw new Error('the second night failed');
            },
        });
        expect(runs).toBe(3);
        expect(starts).toEqual([0, 24 * 3_600_000, 48 * 3_600_000]);
        expect(lines.some((l) => l.includes('scheduled scan failed'))).toBe(true);
    });

    it('a run that overran its slot is followed at once, not skipped', async () => {
        let t = 0;
        const starts: number[] = [];
        await runOnSchedule({
            everyHours: 1,
            log: jsonLineLog(() => undefined),
            now: () => t,
            sleep: async (ms) => {
                t += ms;
            },
            maxRuns: 2,
            run: async () => {
                starts.push(t);
                t += 90 * 60_000;
            },
        });
        expect(starts).toEqual([0, 90 * 60_000]);
    });
});
