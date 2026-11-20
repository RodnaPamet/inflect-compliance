import { MessagesSquare as LucideMessagesSquare } from "lucide-react";
import type { SVGProps } from "react";

/** `Msgs` — lucide-react `MessagesSquare`, at the set's 18px default size. */
export function Msgs(props: SVGProps<SVGSVGElement>) {
  return <LucideMessagesSquare size={18} {...props} />;
}
