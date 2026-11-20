import { Monitor as LucideMonitor } from "lucide-react";
import type { SVGProps } from "react";

/** `Desktop` — lucide-react `Monitor`, at the set's 18px default size. */
export function Desktop(props: SVGProps<SVGSVGElement>) {
  return <LucideMonitor size={18} {...props} />;
}
