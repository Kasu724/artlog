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
        <button className="text-button back-button" onClick={onCancel}>
          <span aria-hidden="true">←</span> Back
        </button>
      )}
      <div className="welcome-mark" aria-hidden="true">
        <svg viewBox="0 0 150 114" fill="none">
          <path d="m39 24 69-17 21 49-69 18-21-50Z" />
          <path d="m31 36 8-2 20 48 69-18-3-8 8-2 6 15-80 21-28-54Z" />
          <path d="m21 49 9-3 22 48 75-20" />
          <path className="mark-art" d="m62 57 14-16 12 8 10-14 18 19" />
          <circle className="mark-art" cx="97" cy="31" r="5" />
          <path
            className="mark-spark"
            d="M133 8c0 7 3 10 10 10-7 0-10 3-10 10 0-7-3-10-10-10 7 0 10-3 10-10Z"
          />
          <path
            className="mark-flourish"
            d="M4 106c28-16 47-11 66-5 25 8 50 4 73-12"
          />
        </svg>
      </div>
      <h1>ArtLog</h1>
      <p className="welcome-subtitle">Version history for your art files.</p>
      <div className="welcome-options">
        <button
          className="primary-button welcome-action"
          onClick={onChooseClip}
          disabled={busy}
        >
          <Icon name="file" /> Open a .clip file
        </button>
        <button
          className="secondary-button welcome-action"
          onClick={onChooseProject}
          disabled={busy}
        >
          <Icon name="folder" /> Browse saved histories
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
  return (
    <section
      className="recent-projects"
      aria-labelledby="recent-projects-title"
    >
      <h2 id="recent-projects-title">Recently opened</h2>
      {projects.length ? (
        <ul>
          {projects.map((item) => (
            <li key={`${item.root}\0${item.id}`}>
              <button
                type="button"
                className="secondary-button recent-project-button"
                disabled={busy}
                onClick={() => onOpen(item)}
                title={`${item.name}\n${item.root}`}
              >
                <Icon name={item.mode === "folder" ? "folder" : "file"} />
                <span>{item.name}</span>
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
  projects: ProjectSummary[];
  busy: boolean;
  error: string;
  onOpen: (id: string) => void;
  onTrash: () => void;
  onBack: () => void;
}) {
  return (
    <section className="saved-histories">
      <button
        className="text-button back-button"
        onClick={onBack}
        disabled={busy}
      >
        <span aria-hidden="true">←</span> Back
      </button>
      <h1>Saved ArtLog histories</h1>
      <p className="project-path" title={root}>
        <Icon name="folder" /> <span>{root}</span>
      </p>
      {projects.length > 0 ? (
        <ul className="project-choices">
          {projects.map((item) => (
            <li key={item.id}>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => onOpen(item.id)}
              >
                <Icon name={item.mode === "folder" ? "folder" : "file"} />
                <span className="project-choice-name">{item.name}</span>
                <span className="muted-caption">
                  {item.mode === "folder"
                    ? item.recovered
                      ? "Recovered history · read only"
                      : "Historical folder project · read only"
                    : "Single-file project"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="entry-empty">
          <Icon name="history" />
          <div>
            <strong>No saved histories in this folder</strong>
            <p>Choose a folder containing an existing ArtLog history.</p>
          </div>
        </div>
      )}
      <div className="project-choice-actions">
        <button className="text-button" onClick={onTrash} disabled={busy}>
          View ArtLog trash
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
