/**
 * The commit a benchmark stage loads, resolved from the Hugging Face Hub
 * BEFORE the engine starts.
 *
 * TEI cannot be asked afterwards: its `/info` `model_sha` is the `--revision`
 * argument echoed back (router/src/lib.rs at v1.9.4, `model_sha: revision`),
 * so with no `--revision` it is null and a record could never name a commit.
 * So the runner asks the Hub what `main` (or the pinned commit) is, starts the
 * engine with `--revision <that commit>`, and checks `/info` echoes it.
 *
 * The same answer carries the model's `config.model_type` and file list,
 * which is what `teiCpuRefusal` needs to refuse a candidate before a
 * container is started for it.
 *
 * The request carries only the model id; `HF_TOKEN`, when set, goes in the
 * Authorization header for a gated model and nowhere else. The host is a
 * constant: nothing here takes a URL from anyone.
 */
import type { HubModelFacts } from './candidates';

export const HUB_ORIGIN = 'https://huggingface.co';

const COMMIT = /^[0-9a-f]{40}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface HubRevision extends HubModelFacts {
    readonly model: string;
    /** A 40-character commit, always: the parser refuses anything else. */
    readonly sha: string;
}

/** The Hub API URL for one model at `main` or at a pinned commit. */
export function hubRevisionUrl(model: string, pinned: string | null): string {
    if (!MODEL_ID.test(model)) throw new Error(`not a Hub model id: ${model}`);
    if (pinned !== null && !COMMIT.test(pinned)) throw new Error(`${model}: a pinned revision must be a 40-character commit, not ${pinned}`);
    return `${HUB_ORIGIN}/api/models/${model}/revision/${pinned ?? 'main'}`;
}

/**
 * Read the Hub's answer. Refuses an answer about another model, a sha that is
 * not a commit, and — for a pinned revision — a sha other than the pin.
 */
export function parseHubRevision(body: unknown, model: string, pinned: string | null): HubRevision {
    const b = (body ?? {}) as { id?: unknown; modelId?: unknown; sha?: unknown; config?: unknown; siblings?: unknown };
    const id = typeof b.id === 'string' ? b.id : typeof b.modelId === 'string' ? b.modelId : null;
    if (id !== model) throw new Error(`the Hub answered for ${String(id)}, not ${model}`);
    if (typeof b.sha !== 'string' || !COMMIT.test(b.sha)) throw new Error(`the Hub gave ${model} no commit (sha ${String(b.sha)})`);
    if (pinned !== null && b.sha !== pinned) throw new Error(`the Hub resolved ${model}@${pinned} to ${b.sha}`);
    const config = (b.config ?? {}) as { model_type?: unknown };
    const files = Array.isArray(b.siblings)
        ? b.siblings.flatMap((s) => (typeof (s as { rfilename?: unknown })?.rfilename === 'string' ? [(s as { rfilename: string }).rfilename] : []))
        : [];
    return {
        model,
        sha: b.sha,
        modelType: typeof config.model_type === 'string' ? config.model_type : null,
        files,
    };
}

export async function resolveHubRevision(model: string, pinned: string | null): Promise<HubRevision> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (process.env.HF_TOKEN) headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
    const res = await fetch(hubRevisionUrl(model, pinned), { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`the Hub answered ${res.status} for ${model}@${pinned ?? 'main'}`);
    return parseHubRevision(await res.json(), model, pinned);
}
