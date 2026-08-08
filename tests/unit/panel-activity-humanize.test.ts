/**
 * Activity-feed detail sanitiser — the control/task side-panel "Activity" tab
 * must read as narrative ONLY: no `Context: {json}` suffix, no raw change-dump,
 * no bare identifier tokens. Locks the cases observed in the live feed.
 */
// next-intl is ESM (jest can't parse its export); mock it so the component
// module imports cleanly. humanizeDetail itself uses no translations.
jest.mock("next-intl", () => {
    const en = require("../../messages/en.json");
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split(".")
                .reduce((o: unknown, k) =>
                    o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== "string") return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, "g"), String(val));
            return v;
        },
        useLocale: () => "en",
    };
});

import { humanizeDetail } from "@/components/controls-shared/PanelActivityFeed";

describe("humanizeDetail", () => {
    it("drops a bare owner assignment (only a raw cuid) to nothing", () => {
        const raw =
            'Owner set to: cmq12y4yd000801lh22gkqwgj Context: {"requestId":"b1a4f382-4c58-484f-a740-55d592c235cb"}';
        expect(humanizeDetail(raw)).toBeNull();
    });

    it("drops a full change-dump JSON detail to nothing", () => {
        const raw =
            '{"name":"Acceptable use","description":"Define rules","intent":null,"category":"ORGANIZATIONAL","frequency":"QUARTERLY"} Context: {"requestId":"8ef2ee13-2e65-4cbc-a8a5-3be7ece7b7e6"}';
        expect(humanizeDetail(raw)).toBeNull();
    });

    it("keeps a genuine human sentence and strips the Context blob", () => {
        const raw =
            'Test completed. Next due: 2026-09-04 Context: {"requestId":"e6778ded-4ddb-4cee-8f77-bc7115c312df","lastTested":"2026-06-04T09:12:04.448Z"}';
        const out = humanizeDetail(raw);
        expect(out).toBe("Test completed. Next due: 2026-09-04");
        expect(out).not.toMatch(/Context|requestId|\{|\}/);
    });

    it("never leaks JSON braces, Context:, or uuid/cuid tokens", () => {
        const samples = [
            'Status changed Context: {"requestId":"e6778ded-4ddb-4cee-8f77-bc7115c312df"}',
            '{"a":1,"b":[2,3]}',
            'linked cmq12y4yd000801lh22gkqwgj to e6778ded-4ddb-4cee-8f77-bc7115c312df',
        ];
        for (const s of samples) {
            const out = humanizeDetail(s) ?? "";
            expect(out).not.toMatch(/[{}\[\]]/);
            expect(out).not.toMatch(/Context:/i);
            expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            expect(out).not.toMatch(/\bc[a-z0-9]{20,}\b/i);
        }
    });

    it("returns null for empty/whitespace/nullish input", () => {
        expect(humanizeDetail(null)).toBeNull();
        expect(humanizeDetail(undefined)).toBeNull();
        expect(humanizeDetail("   ")).toBeNull();
    });
});
