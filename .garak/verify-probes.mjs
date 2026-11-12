#!/usr/bin/env node
/**
 * Refuse a configured probe the pinned garak does not know.
 *
 *   docker run --rm inflect-garak:ci --list_probes > probes.txt
 *   node .garak/verify-probes.mjs probes.txt .garak/config.yaml
 *
 * garak 0.17.1 prints one plugin per line as
 *
 *   <bold><colour>probes: <reset>dan.DanInTheWild
 *
 * (garak/command.py print_plugins: the `probes.` prefix is STRIPPED from the
 * name and printed as a coloured `probes: ` label, a module header carries a
 * trailing star, an inactive class a trailing sleep mark). The step this
 * replaces grepped for `probes.dan.DanInTheWild`, which that output never
 * contains, so it refused every probe on every night.
 *
 * An unknown name matters because garak's probewise harness logs a probe that
 * fails to load and carries on: the family would silently never be probed.
 *
 * Exit 0 when every configured probe is listed; 1 naming each one that is not;
 * 2 when the inputs cannot be read, or the listing holds no probe at all (an
 * output format this parser does not understand must not read as "all known").
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

/** ANSI SGR sequences (garak colours the `probes: ` label). */
const ANSI = /\u001b\[[0-9;]*m/g;

/** The fully qualified probe classes (`module.Class`) a `--list_probes` output lists. */
export function listedProbes(listing) {
    const names = new Set();
    for (const raw of listing.replace(ANSI, '').split('\n')) {
        const m = /^probes: (\S+)/.exec(raw.trim());
        if (m && m[1].includes('.')) names.add(m[1]);
    }
    return names;
}

/** The probe_spec of a garak YAML config. */
export function configuredProbes(configYaml) {
    const spec = load(configYaml)?.plugins?.probe_spec;
    return typeof spec === 'string' ? spec.split(',').map((p) => p.trim()).filter(Boolean) : [];
}

export function unknownProbes(listing, configured) {
    const known = listedProbes(listing);
    return { known: known.size, unknown: configured.filter((p) => !known.has(p)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [listingPath, configPath] = process.argv.slice(2, 4);
    let listing;
    let config;
    try {
        listing = readFileSync(listingPath, 'utf-8');
        config = readFileSync(configPath, 'utf-8');
    } catch {
        process.stderr.write('usage: verify-probes.mjs <list_probes output> <config.yaml>\n');
        process.exit(2);
    }
    const configured = configuredProbes(config);
    const { known, unknown } = unknownProbes(listing, configured);
    if (known === 0 || configured.length === 0) {
        process.stderr.write(`verify-probes: ${known} probes listed, ${configured.length} configured; refusing\n`);
        process.exit(2);
    }
    for (const p of unknown) process.stdout.write(`::error::garak does not know probe ${p}\n`);
    if (unknown.length) process.exit(1);
    process.stdout.write(`verify-probes: all ${configured.length} configured probes are known to this garak\n`);
}
