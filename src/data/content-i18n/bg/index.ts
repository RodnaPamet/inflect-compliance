/**
 * The Bulgarian content dictionaries (#5996), one JSON file per catalogue:
 * `{ "<English source text>": "<Bulgarian text>" }`.
 *
 * Read from disk on first use, NOT imported. Imported, the 20 MB of JSON was
 * compiled into every server chunk that reaches the lookup, and the production
 * build went past its memory ceiling once the long texts landed. The runtime
 * image copies this folder (Dockerfile, held by
 * `tests/guardrails/catalogue-reaches-production.test.ts`), and both tiers run
 * in `/app`, so the path resolves against the working directory there as it
 * does in a checkout.
 *
 * A JSON file in this folder that is missing from `BG_DICTIONARY_FILES` fails
 * `tests/unit/content-i18n/dictionary.test.ts`. `generic-tasks` is the one
 * dictionary built in code (see its header).
 *
 * Server-only (`node:fs`): the client asks through
 * `POST /api/t/:slug/content-translations`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@/lib/observability';
import { genericTasks } from './generic-tasks';

export const BG_DICTIONARY_FILES = [
    'aiuc-1',
    'cis-v8',
    'coso-icf',
    'dora',
    'eu-ai-act',
    'eu-uas-ops',
    'finos-aigf',
    'gdpr',
    'generic',
    'imda-mgf',
    'internal-controls',
    'iso-27001',
    'iso-27701',
    'iso-42001',
    'iso-clauses',
    'nis2',
    'nist-csf',
    'nist-privacy',
    'nist-ssdf',
    'owasp-agentic',
    'owasp-aisvs',
    'owasp-asvs',
    'policy-templates',
    'shared',
    'soc2',
    'vendor-questionnaires',
] as const;

type Dictionary = Readonly<Record<string, string>>;

let loaded: Readonly<Record<string, Dictionary>> | null = null;

/**
 * Every dictionary, keyed by family. A file that cannot be read or parsed is
 * logged and left out, so its strings show in English rather than failing the
 * page that asked; the unit test loads every file, so CI never ships one.
 */
export function bgDictionaries(): Readonly<Record<string, Dictionary>> {
    if (loaded) return loaded;
    const dir = path.join(process.cwd(), 'src/data/content-i18n/bg');
    const out: Record<string, Dictionary> = { 'generic-tasks': genericTasks };
    for (const name of BG_DICTIONARY_FILES) {
        try {
            out[name] = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')) as Dictionary;
        } catch (err) {
            logger.error('content-i18n: a Bulgarian dictionary could not be read', {
                dictionary: name,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    loaded = out;
    return out;
}
