// Statistics: simple local counters — how much you've asked, how much came
// back, and which models did the work. Nothing here is uploaded anywhere.

import { useState } from "react";
import Button from "../../common/Button";
import Dialog from "../../common/Dialog";
import { useConversations } from "../../../state/conversations";

export default function StatisticsPane() {
  const statistics = useConversations((s) => s.statistics);
  const [confirmReset, setConfirmReset] = useState(false);

  const perModel = Object.entries(statistics.perModel).sort((a, b) => b[1].prompts - a[1].prompts);

  const reset = () => {
    const store = useConversations.getState();
    store.hydrate({
      conversations: store.conversations,
      projects: store.projects,
      currentId: store.currentId,
      statistics: { promptsSent: 0, charsGenerated: 0, perModel: {} },
    });
    setConfirmReset(false);
  };

  return (
    <>
      <div className="pane-header">
        <div className="pane-title">Statistics</div>
        <div className="pane-sub">Local counters — they never leave this PC.</div>
      </div>

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-tile-value">{statistics.promptsSent.toLocaleString()}</div>
          <div className="stat-tile-label">Prompts sent</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-value">{statistics.charsGenerated.toLocaleString()}</div>
          <div className="stat-tile-label">Characters generated</div>
        </div>
        <div className="stat-tile">
          <div className="stat-tile-value">{perModel.length}</div>
          <div className="stat-tile-label">Models used</div>
        </div>
      </div>

      <div className="settings-card">
        {perModel.length === 0 ? (
          <div className="settings-note" style={{ marginTop: 0 }}>
            Nothing counted yet — send a message and come back.
          </div>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Prompts</th>
                <th className="num">Characters</th>
              </tr>
            </thead>
            <tbody>
              {perModel.map(([key, stats]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td className="num">{stats.prompts.toLocaleString()}</td>
                  <td className="num">{stats.chars.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
          Reset statistics
        </Button>
      </div>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset statistics?"
        footer={
          <>
            <Button size="sm" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={reset}>
              Reset
            </Button>
          </>
        }
      >
        <p>All counters go back to zero. Your chats are untouched.</p>
      </Dialog>
    </>
  );
}
