/**
 * The worker's and scheduler's lines pass the Ops Agent's filter (#5022).
 *
 * `deploy/ops-agent-config.yaml` ships a container log line to Cloud Logging
 * only when its text contains every string its `exclude_logs` processor tests
 * with `!~` (today `requestId` and `msg`). The worker logged through a bare
 * `pino()` with no `requestId`, so none of its job lines, failures included,
 * ever left the VM. These tests emit real lines through the shared process
 * logger and hold them to the strings read from the config file, so a change
 * to either side fails here rather than going quiet in production.
 */
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import * as ts from 'typescript';
import * as yaml from 'js-yaml';

import { createProcessLogger } from '@/lib/observability/process-logger';
import { REPO_ROOT, repoFiles, repoRelative } from '../../helpers/repo-files';

/** Every string the agent's exclude_logs processors require a line to contain. */
function requiredSubstrings(): string[] {
    const cfg = yaml.load(readFileSync(`${REPO_ROOT}/deploy/ops-agent-config.yaml`, 'utf8')) as {
        logging: { processors: Record<string, { type: string; match_any?: string[] }> };
    };
    const out: string[] = [];
    for (const p of Object.values(cfg.logging.processors)) {
        if (p.type !== 'exclude_logs') continue;
        for (const expr of p.match_any ?? []) {
            const m = /^jsonPayload\.message !~ "([^"]+)"$/.exec(expr.trim());
            if (m) out.push(m[1]);
        }
    }
    return out;
}

function capture(): { stream: Writable; lines: string[] } {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            lines.push(...String(chunk).split('\n').filter(Boolean));
            cb();
        },
    });
    return { stream, lines };
}

describe('the worker and scheduler logs reach Cloud Logging (#5022)', () => {
    it('reads the filter from the agent config, so an empty read cannot pass', () => {
        expect(requiredSubstrings()).toEqual(expect.arrayContaining(['requestId', 'msg']));
    });

    it.each(['worker', 'scheduler'] as const)(
        'every %s line, at every level, contains what the filter keeps',
        (name) => {
            const { stream, lines } = capture();
            const log = createProcessLogger(name, stream);
            log.info({ jobName: 'identity-sync', jobId: 'j1' }, 'processing job');
            log.error({ jobName: 'identity-sync', errorMessage: 'connect ECONNREFUSED' }, 'job processing failed');
            log.warn({ jobId: 'j1' }, 'job stalled — will be retried');
            log.fatal('REDIS_URL is not set. Cannot start worker.');

            expect(lines).toHaveLength(4);
            const needles = requiredSubstrings();
            for (const line of lines) {
                expect(needles.filter((n) => !line.includes(n))).toEqual([]);
                expect(JSON.parse(line).requestId).toBe(name);
            }
        },
    );

    it('a requestId passed to a call still wins', () => {
        const { stream, lines } = capture();
        createProcessLogger('worker', stream).info({ requestId: 'job-42' }, 'processing job');
        expect(JSON.parse(lines[0]).requestId).toBe('job-42');
    });
});

describe('no process builds its own pino instance', () => {
    /**
     * A bare `pino(...)` is how the worker's lines lost `requestId`. Two files
     * may construct one: the app logger and the process logger.
     */
    const ALLOWED = new Set(['src/lib/observability/logger.ts', 'src/lib/observability/process-logger.ts']);

    it('pino() is called only by the two observability loggers', () => {
        const callers: string[] = [];
        for (const file of [
            ...repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }),
            ...repoFiles({ under: 'scripts', extensions: ['.ts', '.mts', '.mjs'] }),
        ]) {
            const text = readFileSync(file, 'utf8');
            if (!/\bpino\s*\(/.test(text)) continue;
            const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'pino') {
                    callers.push(repoRelative(file));
                }
                ts.forEachChild(node, visit);
            };
            visit(sf);
        }
        expect([...new Set(callers)].filter((f) => !ALLOWED.has(f))).toEqual([]);
        expect(new Set(callers)).toEqual(ALLOWED);
    });
});
