import { FileArchive as LucideFileArchive } from "lucide-react";
import type { SVGProps } from "react";

/** `FileZip2` — lucide-react `FileArchive`, at the set's 18px default size. */
export function FileZip2(props: SVGProps<SVGSVGElement>) {
  return <LucideFileArchive size={18} {...props} />;
}
