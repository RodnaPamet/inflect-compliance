import { BadgeCheck as LucideBadgeCheck } from "lucide-react";
import type { SVGProps } from "react";

/** `BadgeCheck` — lucide-react `BadgeCheck`, at the set's 18px default size. */
export function BadgeCheck(props: SVGProps<SVGSVGElement>) {
  return <LucideBadgeCheck size={18} {...props} />;
}
