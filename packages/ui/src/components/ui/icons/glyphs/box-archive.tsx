import { Archive as LucideArchive } from "lucide-react";
import type { SVGProps } from "react";

/** `BoxArchive` — lucide-react `Archive`, at the set's 18px default size. */
export function BoxArchive(props: SVGProps<SVGSVGElement>) {
  return <LucideArchive size={18} {...props} />;
}
