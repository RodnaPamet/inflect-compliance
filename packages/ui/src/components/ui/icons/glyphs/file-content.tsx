import { FileText as LucideFileText } from "lucide-react";
import type { SVGProps } from "react";

/** `FileContent` — lucide-react `FileText`, at the set's 18px default size. */
export function FileContent(props: SVGProps<SVGSVGElement>) {
  return <LucideFileText size={18} {...props} />;
}
