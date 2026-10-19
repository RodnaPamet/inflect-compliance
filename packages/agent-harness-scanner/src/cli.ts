/**
 * `agent-harness-scanner` — the command line.
 *
 *   scan        --config <file> [--dry-run]   one scan; posts it, or prints it with --dry-run
 *   schedule    --config <file>               scan now, then every `schedule.everyHours`
 *   public-key  --config <file>               print the raw public key to register in the tenant
 *
 * Run with `npx tsx packages/agent-harness-scanner/src/cli.ts …` from the
 * repository, or as the container's entrypoint (`../Dockerfile`, #3686).
 * Credentials come from the environment variables the configuration names.
 * The CLI passes no `fetchImpl`: that seam belongs to the tests.
 */
import { readFileSync } from 'fs';

import { parseScannerConfig } from './config';
import { jsonLineLog } from './log';
import { rawPublicKeyHex } from './report';
import { loadSigningKey, runScan, scanAndPost } from './scan';
import { runOnSchedule } from './schedule';

function arg(argv: readonly string[], name: string): string | null {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
    const log = jsonLineLog();
    const [command] = argv;
    const file = arg(argv, '--config');
    if (!command || !file) {
        process.stderr.write('usage: agent-harness-scanner <scan|schedule|public-key> --config <file> [--dry-run]\n');
        return 2;
    }
    const config = parseScannerConfig(JSON.parse(readFileSync(file, 'utf8')) as unknown);

    switch (command) {
        case 'public-key': {
            const pem = env[config.scanner.signingKeyEnv];
            if (!pem) throw new Error(`environment variable ${config.scanner.signingKeyEnv} is not set`);
            process.stdout.write(`${rawPublicKeyHex(loadSigningKey(pem).publicKey)}\n`);
            return 0;
        }
        case 'scan': {
            if (argv.includes('--dry-run')) {
                const { raw } = await runScan({ config, env, log });
                process.stdout.write(`${raw}\n`);
                return 0;
            }
            return (await scanAndPost({ config, env, log })).ok ? 0 : 1;
        }
        case 'schedule':
            await runOnSchedule({
                everyHours: config.schedule.everyHours,
                log,
                run: async () => {
                    await scanAndPost({ config, env, log });
                },
            });
            return 0;
        default:
            process.stderr.write(`unknown command: ${command}\n`);
            return 2;
    }
}

if (require.main === module) {
    // In the container the scanner is process 1, and process 1 is not stopped
    // by a signal it has no handler for: `docker stop` would wait out its grace
    // period and kill it. A scan cut short posts nothing, and a post cut short
    // either landed or did not, so stopping at once loses nothing.
    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
        process.once(signal, () => process.exit(code));
    }
    main(process.argv.slice(2), process.env).then(
        (code) => process.exit(code),
        (err: unknown) => {
            jsonLineLog().error('scanner stopped', { error: err instanceof Error ? err.message : 'unknown' });
            process.exit(1);
        },
    );
}
