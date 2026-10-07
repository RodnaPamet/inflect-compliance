import { cn } from "@inflect/ui/lib/cn";
import { resizeImage } from "@/lib/resize-image";
import { VariantProps, cva } from "class-variance-authority";
import { DragEvent, ReactNode, useState } from "react";
import { useToast } from "./hooks/use-toast";
import { CloudUpload, Icon, LoadingCircle } from "./icons";

type AcceptedFileFormats =
  | "any"
  | "images"
  | "csv"
  | "documents"
  | "programResourceImages"
  | "programResourceFiles"
  | "evidence";

const documentTypes = [
  "application/pdf", // .pdf
  "text/plain", // .txt
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/csv", // .csv
];

// Broad evidence preset — matches the legacy inline upload accept list:
//   .pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.txt,.doc,.docx,.xlsx,.xls,.json,.zip
const evidenceTypes = [
  ...documentTypes,
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/json",
  "application/zip",
];

const acceptFileTypes: Record<
  AcceptedFileFormats,
  { types: string[]; errorMessage?: string }
> = {
  any: { types: [] },
  images: {
    types: ["image/png", "image/jpeg"],
    errorMessage: "File type not supported (.png or .jpg only)",
  },
  csv: {
    types: ["text/csv"],
    errorMessage: "File type not supported (.csv only)",
  },
  documents: {
    types: documentTypes,
    errorMessage: "File type not supported (document files only)",
  },
  // TODO: allow custom `accept` prop so we don't need specific options here
  programResourceImages: {
    types: ["image/svg+xml", "image/png", "image/jpeg", "image/webp"],
    errorMessage: "File type not supported (.svg, .png, .jpg, or .webp only)",
  },
  programResourceFiles: {
    types: [...documentTypes, "application/zip"],
    errorMessage: "File type not supported (document or zip files only)",
  },
  evidence: {
    types: evidenceTypes,
    errorMessage:
      "File type not supported — use PDF, Office, CSV, image, JSON, or ZIP",
  },
};

const imageUploadVariants = cva(
  "group relative isolate flex w-full flex-col items-center justify-center overflow-hidden transition-all",
  {
    variants: {
      variant: {
        default:
          "aspect-[1200/630] rounded-md border border-neutral-300 bg-white hover:bg-bg-muted/50",
        plain: "aspect-[1200/630] bg-white hover:bg-bg-muted/50",
        // Document-oriented dropzone for file-evidence / modal contexts.
        // Uses semantic tokens so the same component works in Epic 54
        // modals without importing the image-centric Dub palette.
        document:
          "min-h-[10rem] rounded-lg border border-dashed border-border-default bg-bg-subtle hover:bg-bg-muted hover:border-border-emphasis",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type FileUploadReadFileProps =
  | {
      /**
       * Whether to automatically read the file and return the result as `src` to onChange
       */
      readFile?: false;
      onChange?: (data: { file: File }) => void;
    }
  | {
      /**
       * Whether to automatically read the file and return the result as `src` to onChange
       */
      readFile: true;
      onChange?: (data: { file: File; src: string }) => void;
    };

export type FileUploadProps = FileUploadReadFileProps & {
  id?: string;
  accept: AcceptedFileFormats;
  className?: string;
  iconClassName?: string;
  previewClassName?: string;

  icon?: Icon;

  /**
   * Custom preview component to display instead of the default
   */
  customPreview?: ReactNode;
  /**
   * Image to display (generally for image uploads)
   */
  imageSrc?: string | null;

  /**
   * Whether to display a loading spinner
   */
  loading?: boolean;

  /**
   * Whether to allow clicking on the area to upload
   */
  clickToUpload?: boolean;

  /**
   * Whether to show instruction overlay when hovered
   */
  showHoverOverlay?: boolean;

  /**
   * Content to display below the upload icon (null to only display the icon)
   */
  content?: ReactNode | null;

  /**
   * Desired resolution to suggest and optionally resize to
   */
  targetResolution?: { width: number; height: number };

  /**
   * A maximum file size (in megabytes) to check upon file selection. Default is 5MB.
   */
  maxFileSizeMB?: number;

  /**
   * Accessibility label for screen readers
   */
  accessibilityLabel?: string;

  disabled?: boolean;
} & VariantProps<typeof imageUploadVariants>;

export function FileUpload({
  id,
  readFile,
  onChange,
  variant,
  className,
  iconClassName,
  previewClassName,
  icon: Icon = CloudUpload,
  customPreview,
  accept = "any",
  imageSrc,
  loading = false,
  clickToUpload = true,
  showHoverOverlay = true,
  content,
  maxFileSizeMB = 5,
  targetResolution,
  accessibilityLabel = "File upload",
  disabled = false,
}: FileUploadProps) {
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const toast = useToast();
  // The `document` variant paints on semantic tokens (dark-theme-safe);
  // the original `default` / `plain` variants keep their opaque-white
  // behaviour for the image-upload callers.
  const isDoc = variant === "document";

  const onFileChange = async (
    e: React.ChangeEvent<HTMLInputElement> | DragEvent,
  ) => {
    const file =
      "dataTransfer" in e
        ? e.dataTransfer.files && e.dataTransfer.files[0]
        : e.target.files && e.target.files[0];
    if (!file) return;

    setFileName(file.name);

    if (maxFileSizeMB > 0 && file.size / 1024 / 1024 > maxFileSizeMB) {
      toast.error(`File size too big (max ${maxFileSizeMB} MB)`);
      return;
    }

    const acceptedTypes = acceptFileTypes[accept].types;

    if (acceptedTypes.length && !acceptedTypes.includes(file.type)) {
      toast.error(
        acceptFileTypes[accept].errorMessage ?? "File type not supported",
      );
      return;
    }

    let fileToUse = file;

    // Add image resizing logic
    if (targetResolution && file.type.startsWith("image/")) {
      try {
        const resizedFile = await resizeImage(file, targetResolution);
        const blob = await fetch(resizedFile).then((r) => r.blob());
        fileToUse = new File([blob], file.name, { type: file.type });
      } catch (error) {
        console.error("Error resizing image:", error);
        // Fallback to original file if resize fails
      }
    }

    // File reading logic
    if (readFile) {
      const reader = new FileReader();
      reader.onload = (e) =>
        onChange?.({ src: e.target?.result as string, file: fileToUse });
      reader.readAsDataURL(fileToUse);
      return;
    }

    onChange?.({ file: fileToUse });
  };

  return (
    <label
      className={cn(
        imageUploadVariants({ variant }),
        !disabled
          ? cn(clickToUpload && "cursor-pointer")
          : "cursor-not-allowed",
        className,
      )}
    >
      {loading && (
        <div
          className={cn(
            "absolute inset-0 z-[5] flex items-center justify-center rounded-[inherit]",
            isDoc ? "bg-bg-subtle" : "bg-white",
          )}
        >
          <LoadingCircle />
        </div>
      )}
      <div
        className="absolute inset-0 z-[5]"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragActive(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          onFileChange(e);
          setDragActive(false);
        }}
      />
      <div
        className={cn(
          "absolute inset-0 z-[3] flex flex-col items-center justify-center rounded-[inherit] border-2 border-transparent transition-all",
          isDoc ? "bg-[inherit]" : "bg-white",
          disabled && (isDoc ? "bg-bg-muted" : "bg-neutral-50"),
          dragActive &&
            !disabled &&
            (isDoc
              ? "cursor-copy border-brand-emphasis bg-bg-muted opacity-100"
              : "cursor-copy border-black bg-neutral-50 opacity-100"),
          imageSrc
            ? cn(
                "opacity-0",
                showHoverOverlay && !disabled && "group-hover:opacity-100",
              )
            : cn(
                !disabled &&
                  (isDoc
                    ? "group-hover:bg-[inherit]"
                    : "group-hover:bg-bg-muted/50"),
              ),
        )}
      >
        <Icon
          className={cn(
            "size-7 transition-all duration-75",
            !disabled
              ? cn(
                  isDoc ? "text-content-muted" : "text-neutral-500",
                  "group-hover:scale-110 group-active:scale-95",
                  dragActive ? "scale-110" : "scale-100",
                )
              : isDoc
                ? "text-content-subtle"
                : "text-neutral-400",
            iconClassName,
          )}
        />
        {content !== null && (
          <div
            className={cn(
              "mt-2 text-center text-sm",
              isDoc ? "text-content-muted" : "text-neutral-500",
              disabled && (isDoc ? "text-content-subtle" : "text-neutral-400"),
            )}
          >
            {content ?? (
              <>
                <p>Drag and drop {clickToUpload && "or click"} to upload.</p>
              </>
            )}
          </div>
        )}
        <span className="sr-only">{accessibilityLabel}</span>
      </div>
      {imageSrc &&
        (customPreview ?? (
          // eslint-disable-next-line @next/next/no-img-element -- imageSrc is a runtime-generated blob URL or upstream-hosted preview; next/image needs known dimensions + remote-pattern allowlisting that this generic upload primitive can't pre-declare. Plain <img> is the right primitive here.
          <img
            src={imageSrc}
            alt="Preview"
            className={cn(
              "h-full w-full rounded-[inherit] object-cover",
              previewClassName,
            )}
          />
        ))}
      {clickToUpload && (
        <div className="sr-only mt-1 flex">
          <input
            id={id}
            key={fileName} // Gets us a fresh input every time a file is uploaded
            type="file"
            accept={acceptFileTypes[accept].types.join(",")}
            onChange={onFileChange}
            disabled={disabled}
          />
        </div>
      )}
    </label>
  );
}
