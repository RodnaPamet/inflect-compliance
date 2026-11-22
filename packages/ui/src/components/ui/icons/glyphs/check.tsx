import { Check as LucideCheck } from "lucide-react";
import type { SVGProps } from "react";

/** `Check` — lucide-react `Check`, at the set's 18px default size. */
export function Check(props: SVGProps<SVGSVGElement>) {
  return <LucideCheck size={18} {...props} />;
}
