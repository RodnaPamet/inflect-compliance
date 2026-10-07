import { cn } from "../../../lib/cn";
import { motion } from "motion/react";

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
      {/* initial={{ d }} seeds a valid starting path so framer-motion
          never morphs `d` from the element's empty/undefined mount state
          to the target — that morph set `d="undefined"` on mount and
          logged an SVG console error for every sortable column header. */}
      <motion.path
        className={cn(!order && "opacity-40")}
        initial={{ d: order === "asc" ? downPath : upPath }}
        animate={{ d: order === "asc" ? downPath : upPath }}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <motion.path
        className="opacity-40"
        initial={{ d: order === "asc" ? upPath : downPath }}
        animate={{ d: order === "asc" ? upPath : downPath }}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
