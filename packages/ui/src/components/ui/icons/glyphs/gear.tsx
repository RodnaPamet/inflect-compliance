import { Settings as LucideSettings } from "lucide-react";
import type { SVGProps } from "react";

/** `Gear` — lucide-react `Settings`, at the set's 18px default size. */
export function Gear(props: SVGProps<SVGSVGElement>) {
  return <LucideSettings size={18} {...props} />;
}
