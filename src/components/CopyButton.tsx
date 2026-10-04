import { useState } from "react";
import { Icon } from "./Icon";

export function CopyButton({
  value,
  label = "Copy",
  onCopied,
}: {
  value: string;
  label?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className="inline-flex items-center gap-1 font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant hover:text-primary"
      aria-label={copied ? `${label} copied` : label}
    >
      <Icon name={copied ? "check" : "content_copy"} className="text-sm" />
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}
