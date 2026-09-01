/**
 * `uploadWithProgress` — XHR upload helper behaviour.
 *
 * The module had NO importing test at all, so every refusal path in it was
 * free to regress silently: the pre-aborted-signal short-circuit, the
 * non-2xx rejection, the JSON-parse fallback, the `lengthComputable: false`
 * percent, and the "abort the in-flight XHR when the caller's signal fires"
 * wiring. Each is asserted here on its OUTCOME (resolved value, thrown error
 * class + fields, recorded call arguments) — never on "the function ran".
 *
 * `XMLHttpRequest` is resolved from the global scope at call time, so a fake
 * installed on `globalThis` is enough; no jsdom environment is required.
 */
import {
    uploadWithProgress,
    UploadHttpError,
    UploadAbortedError,
} from '@/lib/upload/upload-with-progress';

/** The subset of `ProgressEvent` the helper actually reads. */
interface ProgressEventLike {
    loaded: number;
    total: number;
    lengthComputable: boolean;
}

/**
 * A hand-driven stand-in for `XMLHttpRequest`. It implements only the
 * members `uploadWithProgress` touches — `open` / `setRequestHeader` /
 * `send` / `abort` / `upload.onprogress` / `onload` / `onerror` / `onabort`
 * / `status` / `responseText` — plus test drivers to fire each callback.
 */
class FakeXhr {
    static instances: FakeXhr[] = [];

    static reset(): void {
        FakeXhr.instances = [];
    }

    static last(): FakeXhr {
        const x = FakeXhr.instances[FakeXhr.instances.length - 1];
        if (!x) throw new Error('no FakeXhr was constructed');
        return x;
    }

    openCalls: Array<{ method: string; url: string }> = [];
    headerCalls: Array<[string, string]> = [];
    sendCalls: unknown[] = [];
    abortCalls = 0;

    status = 0;
    responseText = '';
    upload: { onprogress: ((e: ProgressEventLike) => void) | null } = {
        onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;

    constructor() {
        FakeXhr.instances.push(this);
    }

    open(method: string, url: string): void {
        this.openCalls.push({ method, url });
    }

    setRequestHeader(name: string, value: string): void {
        this.headerCalls.push([name, value]);
    }

    send(body: unknown): void {
        this.sendCalls.push(body);
    }

    abort(): void {
        this.abortCalls += 1;
        this.onabort?.();
    }

    // ─── test drivers ────────────────────────────────────────────────
    emitProgress(e: ProgressEventLike): void {
        this.upload.onprogress?.(e);
    }

    respond(status: number, responseText: string): void {
        this.status = status;
        this.responseText = responseText;
        this.onload?.();
    }

    failNetwork(): void {
        this.onerror?.();
    }
}

/**
 * Deliberate, named cast. `FakeXhr` covers only the ~9 members the helper
 * uses; structurally satisfying the full DOM `XMLHttpRequest` type would
 * mean stubbing forty unrelated members with no test value. The cast is
 * confined to this one helper so the rest of the file stays typed.
 */
function installFakeXhr(): void {
    globalThis.XMLHttpRequest =
        FakeXhr as unknown as typeof globalThis.XMLHttpRequest;
}

const originalXhr: typeof globalThis.XMLHttpRequest | undefined =
    globalThis.XMLHttpRequest;

beforeEach(() => {
    FakeXhr.reset();
    installFakeXhr();
});

afterAll(() => {
    if (originalXhr) {
        globalThis.XMLHttpRequest = originalXhr;
    } else {
        Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
    }
});

describe('uploadWithProgress — request construction', () => {
    it('defaults to POST and opens the given url', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(200, '{"ok":true}');
        await p;

        expect(FakeXhr.last().openCalls).toEqual([
            { method: 'POST', url: '/api/upload' },
        ]);
    });

    it('honours an explicit PUT method', async () => {
        const p = uploadWithProgress('/api/upload', 'payload', { method: 'PUT' });
        FakeXhr.last().respond(200, '{}');
        await p;

        expect(FakeXhr.last().openCalls[0].method).toBe('PUT');
    });

    it('sets every supplied header, in insertion order', async () => {
        const p = uploadWithProgress('/api/upload', 'payload', {
            headers: { 'x-a': '1', 'x-b': '2' },
        });
        FakeXhr.last().respond(200, '{}');
        await p;

        expect(FakeXhr.last().headerCalls).toEqual([
            ['x-a', '1'],
            ['x-b', '2'],
        ]);
    });

    it('sets NO headers when the option is omitted', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(200, '{}');
        await p;

        expect(FakeXhr.last().headerCalls).toHaveLength(0);
    });

    it('sends the body verbatim', async () => {
        const p = uploadWithProgress('/api/upload', 'the-body');
        FakeXhr.last().respond(200, '{}');
        await p;

        expect(FakeXhr.last().sendCalls).toEqual(['the-body']);
    });
});

describe('uploadWithProgress — progress reporting', () => {
    it('reports a rounded percent when the length is computable', async () => {
        const seen: Array<{ loaded: number; total: number; percent: number | null }> = [];
        const p = uploadWithProgress('/api/upload', 'payload', {
            onProgress: (progress) => {
                seen.push(progress);
            },
        });

        // 2/3 deliberately, not 1/3. `Math.round(33.33) === Math.floor(33.33)`,
        // so a 1/3 sample cannot tell rounding from truncation — measured: the
        // whole file stayed green under `Math.round` → `Math.floor`. 66.67
        // separates them (67 vs 66), and a missing ×100 collapses both to 1.
        FakeXhr.last().emitProgress({ loaded: 2, total: 3, lengthComputable: true });
        FakeXhr.last().respond(200, '{}');
        await p;

        expect(seen).toEqual([{ loaded: 2, total: 3, percent: 67 }]);
    });

    it('reports percent === null when the length is NOT computable', async () => {
        const seen: Array<{ percent: number | null }> = [];
        const p = uploadWithProgress('/api/upload', 'payload', {
            onProgress: (progress) => {
                seen.push({ percent: progress.percent });
            },
        });

        FakeXhr.last().emitProgress({ loaded: 512, total: 0, lengthComputable: false });
        FakeXhr.last().respond(200, '{}');
        await p;

        expect(seen).toHaveLength(1);
        // Explicit null, not undefined — `toEqual` would not tell them apart.
        expect(seen[0].percent).toBeNull();
    });

    it('does not install an upload handler when onProgress is omitted', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        expect(FakeXhr.last().upload.onprogress).toBeNull();

        FakeXhr.last().respond(200, '{}');
        await p;
    });
});

describe('uploadWithProgress — response handling', () => {
    it('resolves the parsed JSON body on 200', async () => {
        const p = uploadWithProgress<{ id: string }>('/api/upload', 'payload');
        FakeXhr.last().respond(200, '{"id":"ev_1"}');

        await expect(p).resolves.toEqual({ id: 'ev_1' });
    });

    it('resolves null when the 2xx response has an EMPTY body', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(204, '');

        await expect(p).resolves.toBeNull();
    });

    it('resolves the RAW text when a 2xx body is not JSON', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(200, 'not json at all');

        await expect(p).resolves.toBe('not json at all');
    });

    it('resolves at the top of the 2xx band (299)', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(299, '{"ok":1}');

        await expect(p).resolves.toEqual({ ok: 1 });
    });

    it('rejects with UploadHttpError just below the band (199)', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(199, 'nope');

        await expect(p).rejects.toBeInstanceOf(UploadHttpError);
    });

    it('rejects with UploadHttpError just above the band (300)', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(300, 'redirect');

        await expect(p).rejects.toBeInstanceOf(UploadHttpError);
    });

    it('carries status, raw body and PARSED body on a JSON error response', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(413, '{"error":"too_large"}');

        const err: unknown = await p.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UploadHttpError);
        const httpErr = err as UploadHttpError;
        expect(httpErr.status).toBe(413);
        expect(httpErr.body).toBe('{"error":"too_large"}');
        expect(httpErr.parsedBody).toEqual({ error: 'too_large' });
        expect(httpErr.message).toBe('upload failed with status 413');
        expect(httpErr.name).toBe('UploadHttpError');
    });

    it('falls back to the raw text as parsedBody on a non-JSON error response', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(500, '<html>gateway</html>');

        const err = (await p.catch((e: unknown) => e)) as UploadHttpError;
        expect(err.parsedBody).toBe('<html>gateway</html>');
    });

    it('reports parsedBody === null for an EMPTY error body', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().respond(502, '');

        const err = (await p.catch((e: unknown) => e)) as UploadHttpError;
        expect(err.status).toBe(502);
        expect(err.parsedBody).toBeNull();
    });

    it('rejects with a plain network Error when the transport fails', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().failNetwork();

        const err = (await p.catch((e: unknown) => e)) as Error;
        expect(err.message).toBe('network error');
        // Not an UploadHttpError — the caller distinguishes transport
        // failure from a server refusal.
        expect(err).not.toBeInstanceOf(UploadHttpError);
    });
});

describe('uploadWithProgress — abort semantics', () => {
    it('rejects immediately and constructs NO XHR when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const p = uploadWithProgress('/api/upload', 'payload', {
            signal: controller.signal,
        });

        await expect(p).rejects.toBeInstanceOf(UploadAbortedError);
        // The short-circuit must happen BEFORE the request is opened — a
        // regression that drops it would still reject (via onabort), so the
        // instance count is the only thing that catches it.
        expect(FakeXhr.instances).toHaveLength(0);
    });

    it('aborts the in-flight XHR when the signal fires mid-upload', async () => {
        const controller = new AbortController();
        const p = uploadWithProgress('/api/upload', 'payload', {
            signal: controller.signal,
        });

        expect(FakeXhr.last().abortCalls).toBe(0);
        controller.abort();

        await expect(p).rejects.toBeInstanceOf(UploadAbortedError);
        expect(FakeXhr.last().abortCalls).toBe(1);
    });

    it('rejects with UploadAbortedError when the XHR aborts on its own', async () => {
        const p = uploadWithProgress('/api/upload', 'payload');
        FakeXhr.last().abort();

        const err = (await p.catch((e: unknown) => e)) as UploadAbortedError;
        expect(err).toBeInstanceOf(UploadAbortedError);
        expect(err.name).toBe('UploadAbortedError');
        expect(err.message).toBe('upload aborted');
    });

    it('does not abort the XHR when no signal is supplied', async () => {
        const unrelated = new AbortController();
        const p = uploadWithProgress('/api/upload', 'payload');

        unrelated.abort();
        expect(FakeXhr.last().abortCalls).toBe(0);

        FakeXhr.last().respond(200, '{"ok":true}');
        await expect(p).resolves.toEqual({ ok: true });
    });
});
