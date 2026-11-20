import { Store as LucideStore } from "lucide-react";
import type { SVGProps } from "react";

/** `Shop` — lucide-react `Store`, at the set's 18px default size. */
export function Shop(props: SVGProps<SVGSVGElement>) {
  return <LucideStore size={18} {...props} />;
}
