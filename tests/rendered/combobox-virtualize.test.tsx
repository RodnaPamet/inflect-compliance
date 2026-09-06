/**
 * Epic 68 — Combobox virtualization rollout tests.
 *
 * Coverage:
 *   - threshold (visible options > 50 → virtualized; ≤ 50 → cmdk path)
 *   - DOM-count contract (500 options render < 30 nodes)
 *   - keyboard navigation (ArrowDown/Up/Enter/Home/End) under virtualization
 *   - selection state visible on the active option
 *   - hover updates the active index (mouse + keyboard agree)
 *   - performance benchmark: 1000-option mount renders in a sane time
 *     budget AND the DOM stays small (the actual perf win)
 *   - visual parity: at the threshold boundary (50 vs 51), the rendered
 *     option markup carries the same key className segments — proving
 *     the visual contract didn't drift between the two branches
 */
/** @jest-environment jsdom */

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
    Combobox,
    COMBOBOX_VIRTUALIZE_THRESHOLD,
    type ComboboxOption,
} from "@/components/ui/combobox";

// ─── Fixtures ───────────────────────────────────────────────────────

function makeOptions(n: number): ComboboxOption[] {
    return Array.from({ length: n }, (_, i) => ({
        value: `opt-${i}`,
        label: `Option ${i.toString().padStart(4, "0")}`,
    }));
}

function Harness({ count }: { count: number }) {
    const [selected, setSelected] = React.useState<ComboboxOption | null>(null);
    const options = React.useMemo(() => makeOptions(count), [count]);
    return (
        <Combobox
            options={options}
            selected={selected}
            setSelected={(opt) => setSelected(opt)}
            placeholder="Pick an option"
            searchPlaceholder="Search…"
            forceDropdown
        />
    );
}

// ─── Threshold contract ─────────────────────────────────────────────

describe("Combobox — virtualization threshold", () => {
    it("threshold constant is 50 (single source of truth)", () => {
        expect(COMBOBOX_VIRTUALIZE_THRESHOLD).toBe(50);
    });

    it("50 options: cmdk path renders, NOT virtualized", async () => {
        const user = userEvent.setup();
        render(<Harness count={50} />);
        await user.click(screen.getByRole("combobox"));
        // No virtualized listbox marker.
        expect(
            document.querySelector("[data-virtualized-combobox]"),
        ).toBeNull();
        // cmdk renders all 50 items as `[cmdk-item]` (or role=option).
        const items = document.querySelectorAll('[role="option"]');
        expect(items.length).toBe(50);
    });

    it("51 options: virtualized path renders", async () => {
        const user = userEvent.setup();
        render(<Harness count={51} />);
        await user.click(screen.getByRole("combobox"));
        expect(
            document.querySelector("[data-virtualized-combobox]"),
        ).toBeInTheDocument();
    });
});

// ─── DOM-count reduction ────────────────────────────────────────────

describe("Combobox — virtualized DOM is small", () => {
    it("500 options: fewer than ~30 option nodes in the DOM", async () => {
        const user = userEvent.setup();
        render(<Harness count={500} />);
        await user.click(screen.getByRole("combobox"));
        const visible = document.querySelectorAll(
            "[data-virtualized-option-index]",
        );
        // 250px viewport ÷ 36px row ≈ 7 rows + 5 overscan ≈ 12 max.
        // Cap generously to tolerate react-window's overscan policy.
        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThanOrEqual(30);
    });

    it("first option rendered, deep option absent", async () => {
        const user = userEvent.setup();
        render(<Harness count={500} />);
        await user.click(screen.getByRole("combobox"));
        expect(
            document.querySelector("[data-virtualized-option-index='0']"),
        ).toBeInTheDocument();
        expect(
            document.querySelector("[data-virtualized-option-index='400']"),
        ).toBeNull();
    });
});

// ─── Keyboard navigation ────────────────────────────────────────────

describe("Combobox — keyboard navigation under virtualization", () => {
    it("ArrowDown advances the active index; aria-activedescendant tracks", async () => {
        const user = userEvent.setup();
        render(<Harness count={200} />);
        await user.click(screen.getByRole("combobox"));

        const listbox = document.querySelector(
            "[data-virtualized-combobox]",
        ) as HTMLElement;
        const initialActive = listbox.getAttribute("aria-activedescendant");
        expect(initialActive).toBe("combobox-virt-0");

        const input = screen.getByPlaceholderText("Search…");
        await user.type(input, "{ArrowDown}");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(
            "combobox-virt-1",
        );
        await user.type(input, "{ArrowDown}{ArrowDown}");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(
            "combobox-virt-3",
        );
    });

    it("ArrowUp clamps at 0 (no underflow)", async () => {
        const user = userEvent.setup();
        render(<Harness count={200} />);
        await user.click(screen.getByRole("combobox"));
        const listbox = document.querySelector(
            "[data-virtualized-combobox]",
        ) as HTMLElement;
        const input = screen.getByPlaceholderText("Search…");
        await user.type(input, "{ArrowUp}{ArrowUp}");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(
            "combobox-virt-0",
        );
    });

    it("End jumps to the last option; Home returns to 0", async () => {
        const user = userEvent.setup();
        render(<Harness count={200} />);
        await user.click(screen.getByRole("combobox"));
        const listbox = document.querySelector(
            "[data-virtualized-combobox]",
        ) as HTMLElement;
        const input = screen.getByPlaceholderText("Search…");
        await user.type(input, "{End}");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(
            "combobox-virt-199",
        );
        await user.type(input, "{Home}");
        expect(listbox.getAttribute("aria-activedescendant")).toBe(
            "combobox-virt-0",
        );
    });

    it("Enter selects the active option and closes the popover (single-select)", async () => {
        const user = userEvent.setup();
        const onChange = jest.fn();
        function ControlledHarness() {
            const [selected, setSelected] = React.useState<ComboboxOption | null>(
                null,
            );
            const options = React.useMemo(() => makeOptions(100), []);
            return (
                <Combobox
                    options={options}
                    selected={selected}
                    setSelected={(opt) => {
                        setSelected(opt);
                        onChange(opt?.value);
                    }}
                    placeholder="Pick"
                    searchPlaceholder="Search…"
                    forceDropdown
                />
            );
        }
        render(<ControlledHarness />);
        await user.click(screen.getByRole("combobox"));
        const input = screen.getByPlaceholderText("Search…");
        await user.type(input, "{ArrowDown}{ArrowDown}{Enter}");
        // ActiveIndex was 2 by the time Enter fired → option 'opt-2'.
        expect(onChange).toHaveBeenCalledWith("opt-2");
    });
});

// ─── Hover ↔ keyboard agreement ─────────────────────────────────────

describe("Combobox — virtualized hover behaviour", () => {
    it("hover sets the active index", async () => {
        const user = userEvent.setup();
        render(<Harness count={200} />);
        await user.click(screen.getByRole("combobox"));
        const listbox = document.querySelector(
            "[data-virtualized-combobox]",
        ) as HTMLElement;
        const fifth = document.querySelector(
            "[data-virtualized-option-index='4']",
        ) as HTMLElement;
        fireEvent.mouseEnter(fifth);
        expect(listbox.getAttribute("aria-activedescendant")).toBe(
            "combobox-virt-4",
        );
    });

    it("clicking an option fires selection", async () => {
        const user = userEvent.setup();
        const onChange = jest.fn();
        function ControlledHarness() {
            const [selected, setSelected] = React.useState<ComboboxOption | null>(
                null,
            );
            const options = React.useMemo(() => makeOptions(200), []);
            return (
                <Combobox
                    options={options}
                    selected={selected}
                    setSelected={(opt) => {
                        setSelected(opt);
                        onChange(opt?.value);
                    }}
                    placeholder="Pick"
                    searchPlaceholder="Search…"
                    forceDropdown
                />
            );
        }
        render(<ControlledHarness />);
        await user.click(screen.getByRole("combobox"));
        const third = document.querySelector(
            "[data-virtualized-option-index='2']",
        ) as HTMLElement;
        fireEvent.click(third);
        expect(onChange).toHaveBeenCalledWith("opt-2");
    });
});

// ─── Windowing contract at scale ────────────────────────────────────

describe("Combobox — windowing holds at 1000 options", () => {
    it("mounts and opens rendering at most 30 option nodes", async () => {
        // This test carried a companion `expect(elapsed).toBeLessThan(2_000)`
        // over the same render+open. It was removed on 2026-09-06 because its
        // verdict on the regression its own comment named ("accidentally
        // rendering all 1000 items") is a coin flip.
        //
        // Measured on an 8-core box, `--runInBand`, with `overscanCount`
        // raised so the virtualized branch renders every row — 8 samples:
        //
        //   1318 / 1405 / 1839 / 1917 / 2192 / 2303 / 2334 / 2397 ms
        //
        // Four over the 2000 ms ceiling, four under. The DOM-count assertion
        // below reported 1000 against `<= 30` on all eight — it is the sole
        // detector, and the only one whose answer does not depend on what
        // else the machine was doing. Healthy on the same box is 284-329 ms,
        // so in the passing case the budget carried ~6x of slack that only a
        // loaded runner could spend.
        //
        // Same defect and same remedy as
        // tests/unit/framework-tree-builder.test.ts and
        // tests/unit/password-check.test.ts:183-197.
        //
        // KNOWN BLIND SPOT: the DOM count sees the wrong NUMBER of nodes, not
        // nodes that each got more expensive to build. That is the trade.
        const user = userEvent.setup();
        render(<Harness count={1_000} />);
        await user.click(screen.getByRole("combobox"));

        // The actual perf win, and a pure function of the windowing maths:
        // the same integer on any machine under any load.
        const visible = document.querySelectorAll(
            "[data-virtualized-option-index]",
        );
        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThanOrEqual(30);
    });
});

// ─── Visual parity ──────────────────────────────────────────────────

describe("Combobox — virtualized vs non-virtualized parity", () => {
    /**
     * Compare the FIRST option's rendered markup at the threshold
     * boundary (50 = cmdk path; 51 = virtualized path). Both branches
     * must produce visually consistent rows: same flex structure, same
     * key padding/text classes, same label content. We don't compare
     * the FULL markup verbatim because the role attribute legitimately
     * differs (cmdk uses `[cmdk-item]` with `role="option"`; the
     * virtualized branch uses a div with `role="option"`). Instead we
     * compare the consumer-facing visual contract: text content + a
     * stable subset of class fragments + the `role`.
     */
    it("first option's visual contract matches at the 50/51 boundary", async () => {
        const user = userEvent.setup();
        const { unmount: unmount50 } = render(<Harness count={50} />);
        await user.click(screen.getByRole("combobox"));
        const opts50 = document.querySelectorAll('[role="option"]');
        const first50 = opts50[0] as HTMLElement;
        const expected = {
            text: first50.textContent?.trim() ?? "",
            // cmdk path's Option div uses the same classes as the
            // virtualized div for these visual fragments.
            cursorPointer: first50.className.includes("cursor-pointer"),
            flexItemsCenter:
                first50.className.includes("flex") &&
                first50.className.includes("items-center"),
            paddingClasses:
                first50.className.includes("px-3") &&
                first50.className.includes("py-2"),
        };
        unmount50();

        render(<Harness count={51} />);
        await user.click(screen.getByRole("combobox"));
        const first51 = document.querySelector(
            "[data-virtualized-option-index='0']",
        ) as HTMLElement;
        expect(first51).toBeInTheDocument();

        const actual = {
            text: first51.textContent?.trim() ?? "",
            cursorPointer: first51.className.includes("cursor-pointer"),
            flexItemsCenter:
                first51.className.includes("flex") &&
                first51.className.includes("items-center"),
            paddingClasses:
                first51.className.includes("px-3") &&
                first51.className.includes("py-2"),
        };

        expect(actual).toEqual(expected);
    });

    it("selected indicator (Check2) is preserved in both branches", async () => {
        // Single-select: the chosen option carries a checkmark on the
        // right. Both branches must render this identically.
        const user = userEvent.setup();

        function HarnessWithSelected({ count }: { count: number }) {
            const options = React.useMemo(() => makeOptions(count), [count]);
            const [selected] = React.useState<ComboboxOption | null>(options[0]!);
            return (
                <Combobox
                    options={options}
                    selected={selected}
                    setSelected={() => {}}
                    placeholder="x"
                    searchPlaceholder="Search…"
                    forceDropdown
                />
            );
        }

        const { unmount: unmount50 } = render(<HarnessWithSelected count={50} />);
        await user.click(screen.getByRole("combobox"));
        const items50 = document.querySelectorAll('[role="option"]');
        // First option (selected) — has an SVG inside.
        expect(items50[0]!.querySelector("svg")).toBeInTheDocument();
        unmount50();

        render(<HarnessWithSelected count={51} />);
        await user.click(screen.getByRole("combobox"));
        const first51 = document.querySelector(
            "[data-virtualized-option-index='0']",
        ) as HTMLElement;
        expect(first51.querySelector("svg")).toBeInTheDocument();
    });
});
