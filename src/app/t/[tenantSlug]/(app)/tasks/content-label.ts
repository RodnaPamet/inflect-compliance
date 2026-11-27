/**
 * A label composed around a catalogue name, in the reader's language (#5996).
 *
 * A linked record is named with its code in front: the links loader writes
 * `A.5.1 — Access control`, the entity picker `A.5.1: Access control`. The
 * catalogue translates the name alone, so the label is looked up whole first
 * (a record with no code, or a name that holds the separator itself) and then
 * by the part after the first separator. The code stays as stored.
 *
 * `tc` is `useContentText()`. Display only.
 */
export function composedContentLabel(
    label: string,
    separator: string,
    tc: (text: string) => string,
): string {
    const whole = tc(label);
    const at = label.indexOf(separator);
    if (whole !== label || at === -1) return whole;
    const from = at + separator.length;
    return label.slice(0, from) + tc(label.slice(from));
}
