/**
 * A report metric's definition in the reader's language.
 *
 * `report-definitions.ts` is the registry: English, shipped in the payload
 * beside every figure, and exported in the governance pack as written. The
 * catalog carries the same definition per metric id under `agentMetrics` —
 * `<group>.<name>.{label,population,includes,excludes}`, the two lists already
 * joined — and `tests/guards/bulgarian-ui-chrome-sources.test.ts` holds the
 * English catalog equal to the registry, so a definition edited in one place
 * and not the other fails CI rather than showing a stale translation.
 *
 * Display only: the payload, the pack and anything an assessor cites keep the
 * registry's English. Client-safe.
 */

export interface DefinitionSource {
    readonly id: string;
    readonly label: string;
    readonly population: string;
    readonly includes: readonly string[];
    readonly excludes: readonly string[];
}

export interface DefinitionText {
    readonly label: string;
    readonly population: string;
    /** The list joined with "; ", or "—" when it is empty. */
    readonly includes: string;
    readonly excludes: string;
}

/** How a definition's lists are joined, in the registry and in the catalog. */
export function joinDefinitionList(items: readonly string[]): string {
    return items.length === 0 ? '—' : items.join('; ');
}

/** A translator rooted at `agentMetrics`, with next-intl's optional `has`. */
export interface MetricTranslator {
    (key: string): string;
    has?: (key: string) => boolean;
}

export function definitionText(def: DefinitionSource, t: MetricTranslator): DefinitionText {
    if (typeof t.has === 'function' && t.has(`${def.id}.label`)) {
        return {
            label: t(`${def.id}.label`),
            population: t(`${def.id}.population`),
            includes: t(`${def.id}.includes`),
            excludes: t(`${def.id}.excludes`),
        };
    }
    return {
        label: def.label,
        population: def.population,
        includes: joinDefinitionList(def.includes),
        excludes: joinDefinitionList(def.excludes),
    };
}
