/**
 * The local-prod and staging stacks can store an upload when started from
 * their shipped example env files (#5308).
 *
 * Both stacks used to set `STORAGE_PROVIDER: s3` in each service's
 * `environment:` block while their example env files carried no S3 settings.
 * Two things followed. Every upload threw `S3_BUCKET environment variable is
 * required when STORAGE_PROVIDER=s3`, and an operator who set
 * `STORAGE_PROVIDER=local` in the env file changed nothing, because a value in
 * `environment:` wins over the same key from `env_file:`.
 *
 * So: the provider is chosen in the env file, and the env file that ships with
 * the stack supplies what that provider needs. `src/env.ts` defaults the
 * provider to `s3` when it is unset, so an unset provider needs a bucket too.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');

/** Each stack, and the example its README tells an operator to copy. */
const STACKS = [
    { compose: 'docker-compose.prod.yml', envFile: '.env.production', example: '.env.production.example' },
    { compose: 'docker-compose.staging.yml', envFile: '.env.staging', example: '.env.staging.example' },
] as const;

interface Service {
    env_file?: string | string[];
    environment?: Record<string, unknown> | string[];
}

function servicesReading(composeFile: string, envFile: string): Array<[string, Service]> {
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, composeFile), 'utf8')) as {
        services: Record<string, Service>;
    };
    return Object.entries(doc.services).filter(([, svc]) => {
        const files = svc.env_file === undefined ? [] : ([] as string[]).concat(svc.env_file);
        return files.includes(envFile);
    });
}

function environmentKeys(svc: Service): string[] {
    if (!svc.environment) return [];
    if (Array.isArray(svc.environment)) return svc.environment.map((e) => e.split('=')[0]);
    return Object.keys(svc.environment);
}

/** Uncommented KEY=value lines of a dotenv example. */
function parseExample(file: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m) out.set(m[1], m[2]);
    }
    return out;
}

describe.each(STACKS)('$compose storage provider', ({ compose, envFile, example }) => {
    const readers = servicesReading(compose, envFile);

    it(`has services reading ${envFile} (the population is not empty)`, () => {
        expect(readers.length).toBeGreaterThan(0);
    });

    it('leaves STORAGE_PROVIDER to the env file, so setting it there takes effect', () => {
        const overriding = readers
            .filter(([, svc]) => environmentKeys(svc).includes('STORAGE_PROVIDER'))
            .map(([name]) => name);
        expect(overriding).toEqual([]);
    });

    it(`ships ${example} with what its storage provider needs`, () => {
        const vars = parseExample(example);
        const provider = vars.get('STORAGE_PROVIDER') ?? 's3';
        expect(['local', 's3']).toContain(provider);
        if (provider === 's3') {
            expect(vars.get('S3_BUCKET') ?? '').not.toBe('');
            expect(vars.get('S3_REGION') ?? '').not.toBe('');
        }
    });
});
