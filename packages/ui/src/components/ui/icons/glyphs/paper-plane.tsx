import { Send as LucideSend } from "lucide-react";
import type { SVGProps } from "react";

/** `PaperPlane` — lucide-react `Send`, at the set's 18px default size. */
export function PaperPlane(props: SVGProps<SVGSVGElement>) {
  return <LucideSend size={18} {...props} />;
}
