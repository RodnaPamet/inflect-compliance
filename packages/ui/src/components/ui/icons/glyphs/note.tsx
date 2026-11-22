import { NotepadText as LucideNotepadText } from "lucide-react";
import type { SVGProps } from "react";

/** `Note` — lucide-react `NotepadText`, at the set's 18px default size. */
export function Note(props: SVGProps<SVGSVGElement>) {
  return <LucideNotepadText size={18} {...props} />;
}
