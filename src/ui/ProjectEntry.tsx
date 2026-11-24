import { useId } from "react";
import type { ProjectSummary } from "../types";
import type { RecentProject } from "./recent-projects";
import { Icon } from "./Icon";
import "./project-entry.css";

export function Welcome({
  busy,
  error,
  onChooseProject,
  onChooseClip,
  onCancel,
}: {
  busy: boolean;
  error: string;
  onChooseProject: () => void;
  onChooseClip: () => void;
  onCancel?: () => void;
}) {
  return (
    <section className="welcome-layout">
      {onCancel && (
        <button className="quiet-button back-button" onClick={onCancel}>
          <span aria-hidden="true">←</span> Back
        </button>
      )}
      <div>
        <h1>ArtLog</h1>
        <p className="welcome-subtitle">Version history for your art files.</p>
      </div>
      <div className="welcome-options">
        <button
          className="primary-button welcome-action"
          onClick={onChooseClip}
          disabled={busy}
        >
          Open a .clip file
        </button>
        <button
          className="secondary-button welcome-action"
          onClick={onChooseProject}
          disabled={busy}
        >
          Browse saved histories
        </button>
      </div>
      {error && (
        <p className="error-message welcome-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function RecentProjects({
  projects,
  busy,
  onOpen,
}: {
  projects: RecentProject[];
  busy: boolean;
  onOpen: (item: RecentProject) => void;
}) {
  const locationId = useId();
  return (
    <section
      className="recent-projects"
      aria-labelledby="recent-projects-title"
    >
      <h2 id="recent-projects-title">Recently opened</h2>
      {projects.length ? (
        <ul>
          {projects.map((item, index) => (
            <li key={`${item.root}\0${item.id}`}>
              <button
                type="button"
                className="secondary-button recent-project-button"
                disabled={busy}
                onClick={() => onOpen(item)}
                title={`${item.name}\n${item.root}`}
                aria-label={item.name}
                aria-describedby={`${locationId}-${index}`}
              >
                <bdi>{item.name}</bdi>
                <bdi
                  className="recent-project-location"
                  id={`${locationId}-${index}`}
                >
                  {item.root}
                </bdi>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="recent-projects-empty">
          Projects you open will appear here.
        </p>
      )}
    </section>
  );
}

export function ProjectChoices({
  root,
  projects,
  busy,
  error,
  onOpen,
  onTrash,
  onBack,
}: {
  root: string;
  projects: ProjectSummary[] | null;
  busy: boolean;
  error: string;
  onOpen: (id: string) => void;
  onTrash: () => void;
  onBack: () => void;
}) {
  return (
    <section className="library-view" aria-labelledby="saved-histories-title">
      <button
        className="quiet-button back-button"
        onClick={onBack}
        disabled={busy}
      >
        <span aria-hidden="true">←</span> Back
      </button>
      <h1 className="page-heading" id="saved-histories-title">
        Saved ArtLog histories
      </h1>
      <p className="library-location" title={root}>
        <Icon name="folder" /> <bdi>{root}</bdi>
      </p>
      {projects === null ? (
        busy && <p role="status">Loading saved histories…</p>
      ) : projects.length > 0 ? (
        <ol className="project-choices" role="list">
          {projects.map((item, index) => (
            <li key={item.id}>
              <button
                className="project-choice"
                disabled={busy}
                onClick={() => onOpen(item.id)}
              >
                <span className="register-number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <Icon name={item.mode === "folder" ? "folder" : "file"} />
                <span className="project-choice-details">
                  <bdi className="project-choice-name">{item.name}</bdi>
                  <span className="project-choice-type">
                    {item.mode === "folder"
                      ? item.recovered
                        ? "Recovered history · read only"
                        : "Historical folder project · read only"
                      : "Single-file project"}
                  </span>
                </span>
                <Icon name="chevron" />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="entry-empty">
          <Icon name="history" />
          <div>
            <strong>No saved histories in this folder</strong>
            <p>Choose a folder containing an existing ArtLog history.</p>
          </div>
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {projects !== null && (
        <footer className="project-choice-actions">
          <button className="quiet-button" onClick={onTrash} disabled={busy}>
            View ArtLog trash
          </button>
        </footer>
      )}
    </section>
  );
}
