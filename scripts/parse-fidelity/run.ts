/**
 * Run the parse-fidelity set through the DocumentParser seam, and summarise it.
 *
 *   npx tsx scripts/parse-fidelity/run.ts measure \
 *       --container docling --image <ref@sha256:…> --startup-ms <n> --out record.json
 *   npx tsx scripts/parse-fidelity/run.ts summarize --record record.json
 *
 * `measure` parses every document in `tests/fixtures/parse/` with the backend
 * the seam resolves (`resolveDocumentParser`, so `DOC_PARSER_BASE_URL` names
 * the service, exactly as in the app), scores each against its expected file,
 * and samples the service container's memory and CPU with `docker stats` the
 * whole time. It writes ONE record of raw counts; it computes no rate.
 * `summarize` recomputes every figure from that record (`score.ts`).
 *
 * Run by `.github/workflows/parse-fidelity.yml` on a GitHub runner, against a
 * service on 127.0.0.1. Nothing a parser returns is printed: the record holds
 * counts, and a missed heading is named by the FIXTURE's text, which this
 * repository wrote.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { FixtureExpectation } from './fixtures';
import {
    PARSE_RECORD_FORMAT,
    measurementFaults,
    parseMemUsage,
    renderSummary,
    scoreDocument,
    type CaseRecord,
    type ParseFidelityRecord,
    type ResourceSample,
} from './score';

const run = promisify(execFile);
const FIXTURE_DIR = resolve(__dirname, '../../tests/fixtures/parse');

function arg(name: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    if (!v) throw new Error(`--${name} is required`);
    return v;
}

async function sample(container: string): Promise<ResourceSample> {
    const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', container]);
    const [mem, cpu] = stdout.trim().split('|');
    return { memMiB: parseMemUsage(mem), cpuPct: Number(cpu.replace('%', '')) };
}

async function measure(): Promise<void> {
    const container = arg('container');
    const image = arg('image');
    const startupMs = Number(arg('startup-ms'));
    const out = arg('out');

    // Imported here, not at the top: the seam reads `@/env`, and `summarize`
    // runs where no app environment exists.
    const { resolveDocumentParser } = await import('@/lib/ai/parsing');
    const parser = resolveDocumentParser();
    if (parser.backend === 'stub') throw new Error('DOC_PARSER_BASE_URL is unset: the seam resolved the stub, not a service');

    const manifestBytes = readFileSync(join(FIXTURE_DIR, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString()) as { files: { id: string; file: string }[] };

    // Idle: the service healthy, nothing asked of it yet. Three samples, the
    // highest kept, so one quiet tick does not understate it.
    const idleSamples = [await sample(container), await sample(container), await sample(container)];
    const idle = {
        memMiB: Math.max(...idleSamples.map((s) => s.memMiB)),
        cpuPct: Math.max(...idleSamples.map((s) => s.cpuPct)),
    };

    // Peak: sampled continuously while the set is parsed. `docker stats
    // --no-stream` takes about a second itself, so the loop is back to back.
    let peak: ResourceSample = { ...idle };
    let samples = idleSamples.length;
    let sampling = true;
    const sampler = (async () => {
        while (sampling) {
            try {
                const s = await sample(container);
                samples += 1;
                peak = { memMiB: Math.max(peak.memMiB, s.memMiB), cpuPct: Math.max(peak.cpuPct, s.cpuPct) };
            } catch {
                // A sample the daemon could not answer is a gap, not a figure.
            }
        }
    })();

    const cases: CaseRecord[] = [];
    try {
        for (const entry of manifest.files) {
            const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, 'expected', `${entry.id}.json`), 'utf8')) as FixtureExpectation;
            const bytes = readFileSync(join(FIXTURE_DIR, entry.file));
            const started = Date.now();
            const result = await parser.parse({ bytes, mime: expected.mime });
            const parseMs = Date.now() - started;
            const parsed = result.ok
                ? {
                      headings: result.document.sections.flatMap((s) => (s.heading === null ? [] : [s.heading])),
                      tables: result.document.tables,
                  }
                : null;
            const counts = scoreDocument(expected, parsed);
            cases.push({
                id: entry.id,
                kind: expected.kind,
                lang: expected.lang,
                ocr: expected.ocr,
                outcome: result.ok ? 'ok' : result.reason,
                parseMs,
                counts,
            });
            console.log(`${entry.id}: ${result.ok ? 'ok' : result.reason} in ${(parseMs / 1000).toFixed(1)} s`);
        }
    } finally {
        sampling = false;
        await sampler;
    }

    const { stdout: sizeOut } = await run('docker', ['image', 'inspect', '--format', '{{.Size}}', image]);
    const record: ParseFidelityRecord = {
        format: PARSE_RECORD_FORMAT,
        backend: parser.backend,
        image,
        setSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        runner: {
            cpu: os.cpus()[0]?.model ?? 'unknown',
            cores: os.cpus().length,
            memMiB: Math.round(os.totalmem() / 1024 / 1024),
        },
        footprint: {
            containers: 1,
            imageBytes: Number(sizeOut.trim()),
            startupMs,
            idle,
            peak,
            samples,
        },
        cases,
    };
    writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
}

function summarize(): void {
    const record = JSON.parse(readFileSync(arg('record'), 'utf8')) as ParseFidelityRecord;
    const md = renderSummary(record);
    // To the job log as well as the step summary: tooling that reads job logs
    // cannot read a step summary (the retriever benchmark's rule).
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    // Printed first, judged second: the summary of a broken run is the
    // diagnosis, so it is shown before the step fails on it.
    const faults = measurementFaults(record);
    if (faults.length > 0) {
        for (const f of faults) console.log(`::error::Not a measurement: ${f}`);
        process.exitCode = 1;
    }
}

const command = process.argv[2];
const main = command === 'measure' ? measure : command === 'summarize' ? async () => summarize() : null;
if (!main) {
    console.error('usage: run.ts measure|summarize …');
    process.exit(2);
}
main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
