/**
 * A framework's name on the reports pages, in the reader's language (#5996).
 *
 * The reports usecases version-qualify the name before it gets here
 * (`name:version`, "NIS2 Directive:2022/2555"), and the catalogue translates
 * the name alone. So the text is looked up whole first (a framework with no
 * version) and then by the part before the last colon, with the version kept
 * as stored.
 */
export function frameworkDisplayName(name: string, tc: (text: string) => string): string {
    const whole = tc(name);
    const at = name.lastIndexOf(':');
    if (whole !== name || at <= 0) return whole;
    return tc(name.slice(0, at)) + name.slice(at);
}
