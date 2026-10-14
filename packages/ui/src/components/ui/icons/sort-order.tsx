import { cn } from "../../../lib/cn";

const upPath = "M6.75 8.25L4 11L1.25 8.25";
const downPath = "M6.75 3.75L4 1L1.25 3.75";

export function SortOrder({
  order,
  className,
}: {
  order: "asc" | "desc" | null;
  className?: string;
}) {
  return (
    <svg
      className={cn("w-2 text-content-emphasis", className)}
      viewBox="0 0 8 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* The two chevrons, drawn once. Ascending is descending turned upside
          down about the box's middle (y 6 of 12), so a CSS transform on the
          group flips between them, with a transition the reduced-motion rule
          turns off. It used to morph each path's `d` with framer-motion; as
          the icons barrel is in every route's first load (status-badge.tsx
          imports it), that one icon brought the whole engine with it. */}
      <g
        className="transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          transformOrigin: "4px 6px",
          transform: order === "asc" ? "scaleY(-1)" : undefined,
        }}
      >
        <path
          className={cn(!order && "opacity-40")}
          d={upPath}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="opacity-40"
          d={downPath}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
