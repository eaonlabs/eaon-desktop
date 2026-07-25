// Projects: the grid overview ({kind:"projects"}) and a single project's
// detail view ({kind:"project"}). Deleting the open project (or landing on a
// stale id) falls back to the grid.

import { useEffect, useState } from "react";
import { ArrowLeft, Folder, FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";
import type { Project } from "../../core/types";
import { useConversations } from "../../state/conversations";
import { useUi } from "../../state/ui";
import Button from "../common/Button";
import Dialog from "../common/Dialog";
import "./projects.css";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ProjectsPage() {
  const selection = useUi((s) => s.selection);
  const setSelection = useUi((s) => s.setSelection);
  const projects = useConversations((s) => s.projects);

  const selectedId = selection.kind === "project" ? selection.id : null;
  const project = selectedId ? projects.find((p) => p.id === selectedId) : undefined;

  // Selected project got deleted (or the id is stale) → normalize to the grid.
  useEffect(() => {
    if (selectedId && !project) setSelection({ kind: "projects" });
  }, [selectedId, project, setSelection]);

  if (project) return <ProjectDetail key={project.id} project={project} />;
  return <ProjectsGrid />;
}

function ProjectsGrid() {
  const projects = useConversations((s) => s.projects);
  const conversations = useConversations((s) => s.conversations);
  const newProject = useConversations((s) => s.newProject);
  const setSelection = useUi((s) => s.setSelection);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = newProject(trimmed);
    setCreating(false);
    setName("");
    setSelection({ kind: "project", id });
  };

  return (
    <div className="projects-page">
      <div className="projects-inner">
        <div className="projects-head">
          <h1>Projects</h1>
          <Button variant="secondary" onClick={() => { setName(""); setCreating(true); }}>
            <FolderPlus size={14} /> New project
          </Button>
        </div>
        {projects.length === 0 ? (
          <div className="projects-empty">
            <Folder size={24} />
            <p>Projects keep related chats together — research, work, whatever you're building.</p>
            <Button variant="secondary" onClick={() => { setName(""); setCreating(true); }}>
              Create your first project
            </Button>
          </div>
        ) : (
          <div className="projects-grid">
            {projects.map((p) => {
              const count = conversations.filter((c) => c.projectId === p.id).length;
              return (
                <button
                  key={p.id}
                  className="project-card"
                  onClick={() => setSelection({ kind: "project", id: p.id })}
                >
                  <div className="project-card-name">{p.name}</div>
                  <div className="project-card-meta">
                    {count} {count === 1 ? "chat" : "chats"} · {formatDate(p.createdAt)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New project"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim()} onClick={create}>
              Create
            </Button>
          </>
        }
      >
        <input
          placeholder="Project name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
      </Dialog>
    </div>
  );
}

function ProjectDetail({ project }: { project: Project }) {
  const conversations = useConversations((s) => s.conversations);
  const select = useConversations((s) => s.select);
  const newConversation = useConversations((s) => s.newConversation);
  const renameProject = useConversations((s) => s.renameProject);
  const removeProject = useConversations((s) => s.removeProject);
  const setSelection = useUi((s) => s.setSelection);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const chats = conversations
    .filter((c) => c.projectId === project.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== project.name) renameProject(project.id, trimmed);
    setRenaming(false);
  };

  const openChat = (id: string) => {
    select(id);
    setSelection({ kind: "chat" });
  };

  return (
    <div className="projects-page">
      <div className="projects-inner">
        <div className="projects-head project-detail-head">
          <button
            className="project-back"
            aria-label="Back to projects"
            onClick={() => setSelection({ kind: "projects" })}
          >
            <ArrowLeft size={16} />
          </button>
          {renaming ? (
            <input
              className="project-rename"
              value={draft}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <h1 className="project-title">{project.name}</h1>
          )}
          <div className="project-actions">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Rename project"
              onClick={() => {
                setDraft(project.name);
                setRenaming(true);
              }}
            >
              <Pencil size={13} /> Rename
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={13} /> Delete
            </Button>
          </div>
        </div>

        <Button
          variant="secondary"
          onClick={() => {
            newConversation(project.id);
            setSelection({ kind: "chat" });
          }}
        >
          <Plus size={14} /> New chat in this project
        </Button>

        {chats.length === 0 ? (
          <p className="project-empty-note">No chats here yet — start one above.</p>
        ) : (
          <div className="project-list">
            {chats.map((c) => (
              <button key={c.id} className="project-chat-row" onClick={() => openChat(c.id)}>
                <span className="project-chat-title">{c.title}</span>
                <span className="project-chat-date">{formatDate(c.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete project?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                removeProject(project.id);
                setSelection({ kind: "projects" });
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>
          “{project.name}” will be deleted. Its chats stay in your history — they just leave the
          project.
        </p>
      </Dialog>
    </div>
  );
}
