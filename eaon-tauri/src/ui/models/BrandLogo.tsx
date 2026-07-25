// A model's brand mark, resolved from its name (core/brand owns the
// matching rules and asset paths). Theme-variant marks (OpenAI, Anthropic…)
// follow the document root's data-theme live, so logos swap the instant the
// appearance setting changes. Unknown brands get a quiet monogram instead
// of a broken image.

import { useEffect, useState } from "react";
import { logoFor } from "../../core/brand";
import "./models.css";

type Theme = "dark" | "light";

function readTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Watches data-theme on <html> — applyAppearance stamps it there, and a
 *  MutationObserver is cheaper than threading theme through every consumer. */
function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export default function BrandLogo({ name, size = 18 }: { name: string; size?: number }) {
  const theme = useDocumentTheme();
  const src = logoFor(name, theme);

  if (src) {
    return (
      <img
        className="brand-logo"
        src={src}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  // No known brand — a neutral rounded monogram keeps rows visually aligned.
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      className="brand-monogram"
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.55)) }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
