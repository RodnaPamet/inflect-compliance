/**
 * The scanner's log: one JSON line per event on stderr, kinds and counts only.
 *
 * Nothing a caller passes is trusted to be clean. A string field with a
 * secret's shape is replaced before it is written, so a mistake upstream —
 * an error message that quoted a header — costs a `[redacted]`, not a token in
 * somebody's log pipeline.
 */
import { looksLikeSecret } from '@/lib/agentic/harness-contract';

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

export interface ScannerLog {
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
}

function scrub(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
    const out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(fields ?? {})) out[k] = typeof v === 'string' && looksLikeSecret(v) ? '[redacted]' : v;
    return out;
}

export function jsonLineLog(write: (line: string) => void = (l) => void process.stderr.write(l)): ScannerLog {
    const emit = (level: string) => (msg: string, fields?: LogFields) =>
        write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg: looksLikeSecret(msg) ? '[redacted]' : msg, ...scrub(fields) })}\n`);
    return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
