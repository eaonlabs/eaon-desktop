// Bottom-center toast pill. The store owns the 2.2s lifetime; this component
// keeps the last message around for a beat after it clears so the pill can
// slide out instead of vanishing.

import { useEffect, useState } from "react";
import { useUi } from "../../state/ui";
import "./common.css";

export default function Toast() {
  const toast = useUi((s) => s.toast);
  const [shown, setShown] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (toast !== null) {
      setShown(toast);
      setLeaving(false);
      return;
    }
    if (shown === null) return;
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, 160);
    return () => window.clearTimeout(timer);
  }, [toast, shown]);

  if (shown === null) return null;
  return (
    <div className={leaving ? "toast toast-leave" : "toast"} role="status" aria-live="polite">
      {shown}
    </div>
  );
}
