/**
 * @jest-environment jsdom
 */
/**
 * Branch coverage for the three canvas entity-picker hooks —
 * `useTenantControls`, `useTenantRisks`, `useTenantAssets`.
 *
 * `use-tenant-controls-polling.test.ts` (PR-D) already locks the
 * happy path + the polling cadence for ONE of the three. Everything
 * asserted here is a REFUSAL / FALLBACK path that no existing suite
 * reaches:
 *
 *   • response-shape normalisation (bare array vs `{ controls }` /
 *     `{ risks }` / `{ assets }` vs `{ data }` vs an unrecognised body)
 *   • malformed rows (non-string id dropped; non-string label /
 *     ref / key / status coerced to the documented fallback)
 *   • the INITIAL fetch failing (the polling suite only covers a
 *     failing REVALIDATION, which is the opposite branch)
 *   • a non-`Error` rejection falling back to the generic message
 *   • the empty-slug no-op
 *   • the module cache short-circuiting the second mount
 *   • the `cancelled` guard: a slow response for a PREVIOUS slug
 *     must not clobber the current slug's state
 *
 * The three hooks are byte-for-byte siblings apart from the endpoint,
 * the wrapper key and the label fallbacks, so the shared contract is
 * driven from one table and the per-module differences are asserted
 * in their own blocks.
 */

import { renderHook, waitFor, act } from "@testing-library/react";
import {
    useTenantControls,
    formatControlLabel,
    findTenantControl,
    __resetTenantControlsCacheForTests,
    type TenantControlOption,
} from "@/lib/processes/use-tenant-controls";
import {
    useTenantRisks,
    findTenantRisk,
    __resetTenantRisksCacheForTests,
    type TenantRiskOption,
} from "@/lib/processes/use-tenant-risks";
import {
    useTenantAssets,
    formatAssetLabel,
    findTenantAsset,
    __resetTenantAssetsCacheForTests,
    type TenantAssetOption,
} from "@/lib/processes/use-tenant-assets";

// ─── Typed fetch harness ───────────────────────────────────────────
//
// The hooks call the ambient `fetch` and read only `.ok`, `.status`
// and `.json()`. A full `Response` is not constructible here without
// pulling in undici, so the stub carries exactly that surface and is
// installed through ONE named cast (documented once, rather than an
// `as any` sprayed at each call site).

interface FetchStubResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}
type FetchStub = (input: string) => Promise<FetchStubResponse>;

const originalFetch = globalThis.fetch;

/** Install a stub as the ambient fetch. Restored in `afterEach`. */
function installFetch(
    impl: FetchStub,
): jest.Mock<Promise<FetchStubResponse>, [string]> {
    const spy = jest.fn<Promise<FetchStubResponse>, [string]>(impl);
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
}

function okJson(body: unknown): FetchStub {
    return () =>
        Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(body),
        });
}

function httpError(status: number): FetchStub {
    return () =>
        Promise.resolve({
            ok: false,
            status,
            json: () => Promise.resolve(null),
        });
}

/**
 * A rejection value that is deliberately NOT an `Error`, typed as
 * `unknown` so `Promise.reject` accepts it without the call site
 * looking like a mistake.
 */
const NON_ERROR_REJECTION: unknown = "offline";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/**
 * The narrow view of each hook's state that the shared contract
 * asserts on. The three real state types are structurally assignable
 * to it (their option rows carry extra fields).
 */
interface CommonHookState {
    options: ReadonlyArray<{ id: string; status: string | null }>;
    loading: boolean;
    error: string | null;
}

interface HookCase {
    /** Module name, used as the describe label. */
    name: string;
    hook: (slug: string, options?: { pollMs?: number }) => CommonHookState;
    reset: () => void;
    /** Expected request URL for tenant slug "acme". */
    url: string;
    /** Wrapper key the endpoint may nest rows under. */
    wrapperKey: string;
    /** Prefix of the surfaced error message. */
    errorPrefix: string;
    /** A single well-formed row for this endpoint. */
    row: (id: string, status: string | null) => Record<string, unknown>;
}

const CASES: HookCase[] = [
    {
        name: "useTenantControls",
        hook: useTenantControls,
        reset: __resetTenantControlsCacheForTests,
        url: "/api/t/acme/controls",
        wrapperKey: "controls",
        errorPrefix: "Could not load controls",
        row: (id, status) => ({
            id,
            ref: `${id}-ref`,
            title: `${id} title`,
            status,
        }),
    },
    {
        name: "useTenantRisks",
        hook: useTenantRisks,
        reset: __resetTenantRisksCacheForTests,
        url: "/api/t/acme/risks",
        wrapperKey: "risks",
        errorPrefix: "Could not load risks",
        row: (id, status) => ({ id, title: `${id} title`, status }),
    },
    {
        name: "useTenantAssets",
        hook: useTenantAssets,
        reset: __resetTenantAssetsCacheForTests,
        url: "/api/t/acme/assets",
        wrapperKey: "assets",
        errorPrefix: "Could not load assets",
        row: (id, status) => ({
            id,
            key: `${id}-key`,
            name: `${id} name`,
            status,
        }),
    },
];

function resetAllCaches(): void {
    for (const c of CASES) c.reset();
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAllCaches();
});

describe.each(CASES)("$name — shared refusal + fallback contract", (c) => {
    beforeEach(() => {
        resetAllCaches();
    });

    it("hits the tenant-scoped endpoint exactly once for a cold slug", async () => {
        const spy = installFetch(okJson([c.row("a", "OPEN")]));
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(c.url);
        expect(result.current.options).toHaveLength(1);
    });

    it("normalises the endpoint's wrapper envelope into options", async () => {
        installFetch(
            okJson({
                [c.wrapperKey]: [c.row("a", "OPEN"), c.row("b", "CLOSED")],
            }),
        );
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.options.map((o) => o.id)).toStrictEqual([
            "a",
            "b",
        ]);
        expect(result.current.error).toBeNull();
    });

    it("yields NO options for a body that matches no known shape", async () => {
        // A `{ rows: [...] }` body served with a 200 is the shape this
        // arm exists for: the hook must degrade to an empty picker,
        // not throw and not surface a spurious error string.
        installFetch(okJson({ unexpected: true, rows: [c.row("a", "OPEN")] }));
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.options).toHaveLength(0);
        expect(result.current.error).toBeNull();
    });

    it("drops rows whose id is not a string", async () => {
        installFetch(
            okJson([
                c.row("keep", "OPEN"),
                { ...c.row("x", "OPEN"), id: 42 },
                { ...c.row("y", "OPEN"), id: null },
                { ...c.row("z", "OPEN"), id: undefined },
            ]),
        );
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        // `toHaveLength` rather than `toEqual([...])` on purpose — a
        // dropped row that leaked through as `undefined` would be
        // invisible to `toEqual`.
        expect(result.current.options).toHaveLength(1);
        expect(result.current.options[0]?.id).toBe("keep");
    });

    it("nulls a non-string status rather than passing the raw value through", async () => {
        installFetch(
            okJson([{ ...c.row("a", null), status: { code: "OPEN" } }]),
        );
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.options).toHaveLength(1);
        expect(result.current.options[0]?.status).toBeNull();
    });

    it("surfaces the HTTP status on an INITIAL fetch failure and clears options", async () => {
        installFetch(httpError(503));
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.error).toBe(`${c.errorPrefix} (503)`);
        expect(result.current.options).toHaveLength(0);
        expect(result.current.loading).toBe(false);
    });

    it("falls back to the generic message when the rejection is not an Error", async () => {
        // Some fetch polyfills reject with a bare string rather than
        // an Error. Without the `instanceof Error` guard the picker
        // would surface "undefined" as its error message.
        const rejectWithBareString: FetchStub = () =>
            Promise.reject(NON_ERROR_REJECTION);
        installFetch(rejectWithBareString);
        const { result } = renderHook(() => c.hook("acme"));
        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.error).toBe(c.errorPrefix);
    });

    it("does not fetch at all for an empty slug", async () => {
        const spy = installFetch(okJson([c.row("a", "OPEN")]));
        const { result } = renderHook(() => c.hook(""));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(spy).not.toHaveBeenCalled();
        expect(result.current.options).toHaveLength(0);
        expect(result.current.error).toBeNull();
    });

    it("serves the second mount from the module cache without a network call", async () => {
        const spy = installFetch(okJson([c.row("a", "OPEN")]));
        const first = renderHook(() => c.hook("acme"));
        await waitFor(() =>
            expect(first.result.current.options).toHaveLength(1),
        );
        first.unmount();

        const second = renderHook(() => c.hook("acme"));
        // Cache hit ⇒ options are present on the FIRST committed
        // render, with no loading flash and no second request.
        expect(second.result.current.loading).toBe(false);
        expect(second.result.current.options).toHaveLength(1);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("a stale response for a previous slug never clobbers the current slug", async () => {
        const slow = deferred<FetchStubResponse>();
        const spy = installFetch((input: string) => {
            if (input.includes("/slowtenant/")) return slow.promise;
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve([c.row("fresh", "OPEN")]),
            });
        });

        const { result, rerender } = renderHook(
            ({ slug }: { slug: string }) => c.hook(slug),
            { initialProps: { slug: "slowtenant" } },
        );
        expect(spy).toHaveBeenCalledTimes(1);

        rerender({ slug: "acme" });
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        expect(result.current.options[0]?.id).toBe("fresh");

        // The abandoned request lands LATE. The cancelled guard must
        // swallow it — otherwise the picker silently repopulates with
        // another tenant's rows.
        await act(async () => {
            slow.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve([c.row("stale", "OPEN")]),
            });
            await slow.promise;
        });
        expect(result.current.options).toHaveLength(1);
        expect(result.current.options[0]?.id).toBe("fresh");
    });

    it("a stale FAILURE for a previous slug never overwrites the current state", async () => {
        const slow = deferred<FetchStubResponse>();
        installFetch((input: string) => {
            if (input.includes("/slowtenant/")) return slow.promise;
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve([c.row("fresh", "OPEN")]),
            });
        });

        const { result, rerender } = renderHook(
            ({ slug }: { slug: string }) => c.hook(slug),
            { initialProps: { slug: "slowtenant" } },
        );
        rerender({ slug: "acme" });
        await waitFor(() => expect(result.current.options).toHaveLength(1));

        await act(async () => {
            slow.resolve({
                ok: false,
                status: 500,
                json: () => Promise.resolve(null),
            });
            await slow.promise;
        });
        expect(result.current.error).toBeNull();
        expect(result.current.options).toHaveLength(1);
    });
});

describe("useTenantControls — control-specific fallbacks", () => {
    beforeEach(resetAllCaches);

    it("substitutes '(no title)' for a non-string title and nulls a non-string ref", async () => {
        installFetch(
            okJson([{ id: "c1", ref: 7, title: { en: "Access" }, status: "DONE" }]),
        );
        const { result } = renderHook(() => useTenantControls("acme"));
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        const opt: TenantControlOption | undefined = result.current.options[0];
        expect(opt?.title).toBe("(no title)");
        expect(opt?.ref).toBeNull();
    });

    it("does NOT accept a { data } wrapper (that shape is risks/assets only)", async () => {
        // Locks the asymmetry deliberately: the controls endpoint has
        // no paginated `{ data }` form, so accepting one here would be
        // a silent behaviour change rather than a bug fix.
        installFetch(
            okJson({ data: [{ id: "c1", ref: null, title: "t", status: null }] }),
        );
        const { result } = renderHook(() => useTenantControls("acme"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.options).toHaveLength(0);
    });
});

describe("useTenantRisks / useTenantAssets — { data } wrapper", () => {
    beforeEach(resetAllCaches);

    it("useTenantRisks reads rows out of a { data } envelope", async () => {
        installFetch(
            okJson({ data: [{ id: "r1", title: "Data loss", status: "OPEN" }] }),
        );
        const { result } = renderHook(() => useTenantRisks("acme"));
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        expect(result.current.options[0]?.id).toBe("r1");
    });

    it("useTenantAssets reads rows out of a { data } envelope", async () => {
        installFetch(
            okJson({
                data: [{ id: "a1", key: "SRV-1", name: "Server", status: "ACTIVE" }],
            }),
        );
        const { result } = renderHook(() => useTenantAssets("acme"));
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        expect(result.current.options[0]?.id).toBe("a1");
    });

    it("useTenantRisks substitutes '(untitled)' for a non-string title", async () => {
        installFetch(okJson([{ id: "r1", title: 12, status: "OPEN" }]));
        const { result } = renderHook(() => useTenantRisks("acme"));
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        const opt: TenantRiskOption | undefined = result.current.options[0];
        expect(opt?.title).toBe("(untitled)");
    });

    it("useTenantAssets substitutes '(unnamed)' for a non-string name and nulls a non-string key", async () => {
        installFetch(okJson([{ id: "a1", key: [], name: null, status: "ACTIVE" }]));
        const { result } = renderHook(() => useTenantAssets("acme"));
        await waitFor(() => expect(result.current.options).toHaveLength(1));
        const opt: TenantAssetOption | undefined = result.current.options[0];
        expect(opt?.name).toBe("(unnamed)");
        expect(opt?.key).toBeNull();
    });
});

describe("label formatters", () => {
    it("formatControlLabel drops the separator when ref is absent", () => {
        expect(
            formatControlLabel({
                id: "c",
                ref: "AC-1",
                title: "Access",
                status: null,
            }),
        ).toBe("AC-1 · Access");
        expect(
            formatControlLabel({ id: "c", ref: null, title: "Access", status: null }),
        ).toBe("Access");
        // An empty-string ref is falsy and must NOT produce a
        // dangling " · " prefix.
        expect(
            formatControlLabel({ id: "c", ref: "", title: "Access", status: null }),
        ).toBe("Access");
    });

    it("formatAssetLabel drops the separator when key is absent", () => {
        expect(
            formatAssetLabel({
                id: "a",
                key: "SRV-1",
                name: "Server",
                status: null,
            }),
        ).toBe("SRV-1 · Server");
        expect(
            formatAssetLabel({ id: "a", key: null, name: "Server", status: null }),
        ).toBe("Server");
        expect(
            formatAssetLabel({ id: "a", key: "", name: "Server", status: null }),
        ).toBe("Server");
    });
});

describe("find* helpers", () => {
    // Every fixture list carries an option whose id is the EMPTY
    // STRING. Without it the `id === ""` assertions below could not
    // fail: the scan would find no match, `?? null` would return null,
    // and `if (!id) return null` would be indistinguishable from
    // `if (id === null || id === undefined) return null`. With the
    // fixture present, only the falsy guard yields null.
    const controlOptions: TenantControlOption[] = [
        { id: "c1", ref: null, title: "One", status: "DONE" },
        { id: "c2", ref: "R", title: "Two", status: null },
        { id: "", ref: null, title: "Unsaved draft", status: null },
    ];
    const controlState = {
        options: controlOptions,
        loading: false,
        error: null as string | null,
    };

    it("findTenantControl returns null for a falsy id WITHOUT scanning", () => {
        expect(findTenantControl(controlState, null)).toBeNull();
        // Empty string is falsy too — it must take the same early
        // exit rather than matching the empty-id option in the list.
        expect(findTenantControl(controlState, "")).toBeNull();
    });

    it("findTenantControl returns null when the id is absent from the list", () => {
        expect(findTenantControl(controlState, "nope")).toBeNull();
    });

    it("findTenantControl returns the matching option", () => {
        expect(findTenantControl(controlState, "c2")?.status).toBeNull();
        expect(findTenantControl(controlState, "c1")?.status).toBe("DONE");
    });

    it("findTenantRisk mirrors the contract", () => {
        const riskOptions: TenantRiskOption[] = [
            { id: "r1", title: "One", status: "OPEN" },
            { id: "", title: "Unsaved draft", status: null },
        ];
        const state = {
            options: riskOptions,
            loading: false,
            error: null as string | null,
        };
        expect(findTenantRisk(state, null)).toBeNull();
        expect(findTenantRisk(state, "")).toBeNull();
        expect(findTenantRisk(state, "missing")).toBeNull();
        expect(findTenantRisk(state, "r1")?.title).toBe("One");
    });

    it("findTenantAsset mirrors the contract", () => {
        const assetOptions: TenantAssetOption[] = [
            { id: "a1", key: "K", name: "One", status: null },
            { id: "", key: null, name: "Unsaved draft", status: null },
        ];
        const state = {
            options: assetOptions,
            loading: false,
            error: null as string | null,
        };
        expect(findTenantAsset(state, null)).toBeNull();
        expect(findTenantAsset(state, "")).toBeNull();
        expect(findTenantAsset(state, "missing")).toBeNull();
        expect(findTenantAsset(state, "a1")?.name).toBe("One");
    });
});

// ─── Background revalidation (risks + assets only) ─────────────────
//
// `use-tenant-controls-polling.test.ts` already locks the poll
// contract for useTenantControls and its header reasons that "the
// structural ratchet pins parity, so one behavioural file is
// enough". That ratchet used to grep each hook file for
// `setInterval(`, `runFetch(true)` and `runFetch(false)`
// INDEPENDENTLY — unanchored, so nothing bound the `true` to the
// interval's callback, and an interval calling `runFetch(false)`
// with a stray `runFetch(true)` anywhere else in the file satisfied
// every structural check while still blanking the canvas's status
// chips on the first transient 500. It now bounds its read to the
// `setInterval(...)` call itself (#2238), so the parity claim is
// real. These two cases remain the BEHAVIOURAL half — a bounded
// source match still cannot see a poll that never fires — and are
// deliberately NOT run for controls (that would be duplication).

const POLLING_CASES: HookCase[] = CASES.filter(
    (c) => c.name !== "useTenantControls",
);

describe.each(POLLING_CASES)("$name — background revalidation", (c) => {
    beforeEach(() => {
        resetAllCaches();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("adopts a status change on the next poll tick", async () => {
        let impl: FetchStub = okJson([c.row("a", "OPEN")]);
        const spy = installFetch((input) => impl(input));

        const { result } = renderHook(() =>
            c.hook("acme", { pollMs: 30_000 }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.options[0]?.status).toBe("OPEN");

        impl = okJson([c.row("a", "CLOSED")]);
        await act(async () => {
            jest.advanceTimersByTime(30_000);
        });

        await waitFor(() =>
            expect(result.current.options[0]?.status).toBe("CLOSED"),
        );
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it("keeps the last-good options when a background revalidation fails", async () => {
        let impl: FetchStub = okJson([c.row("a", "OPEN")]);
        installFetch((input) => impl(input));

        const { result } = renderHook(() =>
            c.hook("acme", { pollMs: 10_000 }),
        );
        await waitFor(() => expect(result.current.options).toHaveLength(1));

        impl = httpError(500);
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });

        // The revalidation branch returns early instead of writing an
        // error state — the picker must look untouched.
        expect(result.current.options).toHaveLength(1);
        expect(result.current.options[0]?.status).toBe("OPEN");
        expect(result.current.error).toBeNull();
    });
});
