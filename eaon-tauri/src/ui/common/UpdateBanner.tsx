// Floating "new version" card, top-right. Download opens the platform's
// release destination in the system browser (the webview never navigates).

import { openUrl } from "@tauri-apps/plugin-opener";
import { useUi } from "../../state/ui";
import Button from "./Button";
import "./common.css";

export default function UpdateBanner() {
  const update = useUi((s) => s.update);
  const setUpdate = useUi((s) => s.setUpdate);
  if (!update) return null;

  return (
    <div className="update-banner" role="status">
      <div className="update-title">Eaon {update.latestVersion} is available</div>
      {update.releaseNotes && <p className="update-notes">{update.releaseNotes}</p>}
      <div className="update-actions">
        <Button variant="primary" size="sm" onClick={() => void openUrl(update.url)}>
          Download
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setUpdate(null)}>
          Later
        </Button>
      </div>
    </div>
  );
}
