// A labeled control row for settings-style forms: label + optional hint on
// the left, the control (Switch, input, select…) on the right.

import type { ReactNode } from "react";
import "./common.css";

export interface FieldProps {
  label: string;
  hint?: string;
  children?: ReactNode;
}

export default function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="field">
      <div className="field-text">
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}
