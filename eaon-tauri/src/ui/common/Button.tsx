// The app's one button. Primary fills with the user's accent color; the
// neutral accents ("default" grey and "white") would look wrong or unreadable
// as a fill, so they fall back to an elevated bordered button instead.

import type { ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { useSettings } from "../../state/settings";
import "./common.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  /** Shows a spinner and disables the button while a slow action runs. */
  loading?: boolean;
}

export default function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const accentId = useSettings((s) => s.settings.accentColorId);
  const neutralAccent = accentId === "default" || accentId === "white";
  const cls = [
    "btn",
    `btn-${size}`,
    `btn-${variant}`,
    variant === "primary" && neutralAccent ? "btn-primary-neutral" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <Loader2 size={13} className="btn-spin" aria-hidden />}
      {children}
    </button>
  );
}
