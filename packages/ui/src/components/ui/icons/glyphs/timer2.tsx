import { Timer as LucideTimer } from "lucide-react";
import type { SVGProps } from "react";

/** `Timer2` — lucide-react `Timer`, at the set's 18px default size. */
export function Timer2(props: SVGProps<SVGSVGElement>) {
  return <LucideTimer size={18} {...props} />;
}
