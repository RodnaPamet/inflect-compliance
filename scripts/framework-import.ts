/**
 * `npm run framework:import` — CLI entrypoint for the YAML/JSON
 * catalog ingestion path.
 *
 * Wraps the same `loadAndValidateCatalogFile` + `applyCatalogFile`
 * pair that `prisma/seed-catalog.ts` is migrating onto, so the CLI
 * uses the real import pipeline. No parallel write path; the only
 * difference between `seed-catalog` and this CLI is that the CLI
 * takes ONE file at a time from operator-supplied input and exits
 * with a precise status code.
 *
 * ## Usage
 *
 *   npm run framework:import -- --input <path>          # apply
 *   npm run framework:import -- --input <path> --dry-run # validate only
 *
 *   # equivalent direct invocation:
 *   npx tsx scripts/framework-import.ts --input <path> [--dry-run]
 *
 * ## Exit codes
 *
 *   0 — import (or dry-run validation) succeeded
 *   1 — fatal runtime error (DB unreachable, unexpected exception)
 *   2 — bad CLI arguments (missing --input, etc.)
 *   3 — catalog parse/validation failure (CatalogParseError /
 *       CatalogValidationError) — distinct from runtime errors so
 *       CI/operator scripts can branch on input-quality issues vs
 *       infra issues.
 *
 * ## Output
 *
 *   stdout — JSON-shaped success summary on apply, or a "valid"
 *   line on dry-run. Designed for operator-script consumption.
 *   stderr — human-readable error message (file path + reason).
 */
process.env.SKIP_ENV_VALIDATION = '1';

import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
    loadAndValidateCatalogFile,
    CatalogParseError,
    CatalogValidationError,
} from '../prisma/catalog-loader';
import { applyCatalogFile } from '../prisma/catalog-applier';

interface CliArgs {
    input?: string;
    dryRun: boolean;
    help: boolean;
}

const HELP_TEXT = `
framework:import — apply a YAML/JSON catalog file (Framework + Requirements + Templates + Pack)

Usage:
  npm run framework:import -- --input <path> [--dry-run]
  npx tsx scripts/framework-import.ts --input <path> [--dry-run]

Options:
  --input, -i <path>   Path to the catalog file (.yaml | .yml | .json)
  --dry-run            Parse + validate only; do not write to the DB
  --help, -h           Show this message

Exit codes:
  0  ok
  1  runtime / DB error
  2  bad CLI arguments
  3  catalog parse or validation failure
`;

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { dryRun: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--input':
            case '-i':
                args.input = argv[++i];
                break;
            case '--dry-run':
                args.dryRun = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                // Unknown flags become a CLI-arg error so typos surface loudly.
                if (arg.startsWith('-')) {
                    process.stderr.write(`Unknown flag: ${arg}\n${HELP_TEXT}`);
                    process.exit(2);
                }
                // Bare positional → treat as --input alias.
                if (!args.input) args.input = arg;
        }
    }
    return args;
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    if (!args.input) {
        process.stderr.write(`Error: --input <path> is required.\n${HELP_TEXT}`);
        return 2;
    }

    const inputPath = path.resolve(args.input);

    // ── Phase 1: parse + validate (works for both run modes) ────
    let file;
    try {
        file = loadAndValidateCatalogFile(inputPath);
    } catch (err) {
        if (err instanceof CatalogParseError || err instanceof CatalogValidationError) {
            process.stderr.write(`${err.message}\n`);
            return 3;
        }
        throw err;
    }

    if (args.dryRun) {
        const summary = {
            ok: true,
            mode: 'dry-run' as const,
            input: inputPath,
            framework: file.framework.key,
            requirements: file.requirements.length,
            templates: file.templates.length,
            pack: file.pack?.key ?? null,
        };
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return 0;
    }

    // ── Phase 2: apply ──────────────────────────────────────────
    // Prisma 7 — connections go through the adapter pattern instead
    // of an implicit URL read; mirrors `src/lib/prisma.ts`.
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
    const prisma = new PrismaClient({ adapter });
    try {
        const result = await applyCatalogFile(prisma, file, inputPath);
        const summary = {
            ok: true,
            mode: 'apply' as const,
            input: inputPath,
            framework: result.framework,
            requirements: result.requirements,
            templates: result.templates,
            pack: result.pack ?? null,
            packs: result.packs,
        };
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return 0;
    } catch (err) {
        process.stderr.write(
            `Catalog apply failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
    } finally {
        await prisma.$disconnect();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        process.stderr.write(
            `Unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
        process.exit(1);
    });
