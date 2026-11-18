import type { FileLocation, ProjectSummary, ScanEntry } from "../types";
import { formatBytes } from "./format";
import { Icon } from "./Icon";
import "./project-entry.css";

export type Setup = { root: string; files: ScanEntry[]; tracked: string[] };

export function TrackSetup({
  setup,
  busy,
  error,
  onToggle,
  onSelectAll,
  onCancel,
  onActivate,
}: {
  setup: Setup;
  busy: boolean;
  error: string;
  onToggle: (path: string) => void;
  onSelectAll: (paths: string[]) => void;
  onCancel: () => void;
  onActivate: () => void;
}) {
  const allSelected =
    setup.files.length > 0 && setup.tracked.length === setup.files.length;
  return (
    <section className="setup-view">
      <button className="text-button back-button" onClick={onCancel}>
        <span aria-hidden="true">←</span> Back
      </button>
      <h1>Set up project</h1>
      <p className="project-path" title={setup.root}>
        <Icon name="folder" /> <span>{setup.root}</span>
      </p>

      <section className="setup-card" aria-labelledby="track-heading">
        <div className="section-heading">
          <h2 id="track-heading">Files to track</h2>
          {setup.files.length > 0 && (
            <button
              className="text-button setup-select-all"
              onClick={() =>
                onSelectAll(
                  allSelected ? [] : setup.files.map((file) => file.path),
                )
              }
            >
              {allSelected ? "Clear all" : "Select all"}
            </button>
          )}
        </div>
        <div className="entry-file-list">
          {setup.files.length === 0 ? (
            <div className="entry-empty">
              <Icon name="file" />
              <div>
                <strong>No .clip files found</strong>
                <p>
                  You can create this project now and add Clip Studio Paint
                  files later.
                </p>
              </div>
            </div>
          ) : (
            setup.files.map((file) => (
              <label
                className="entry-file-row"
                key={file.path}
                title={file.path}
              >
                <input
                  aria-label={file.path}
                  type="checkbox"
                  checked={setup.tracked.includes(file.path)}
                  onChange={() => onToggle(file.path)}
                />
                <Icon name="file" />
                <span className="entry-file-name">{file.path}</span>
                <span className="entry-file-type">CLIP</span>
                <span className="entry-file-size">
                  {formatBytes(file.size)}
                </span>
              </label>
            ))
          )}
        </div>
        <div className="setup-foot">
          <span>{setup.tracked.length} selected</span>
          <button
            className="primary-button"
            disabled={busy}
            onClick={onActivate}
          >
            <span>{busy ? "Creating project…" : "Create project"}</span>
          </button>
        </div>
      </section>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <p className="setup-privacy">
        <Icon name="device" /> History is stored in this folder.
      </p>
    </section>
  );
}

export function Welcome({
  busy,
  error,
  onChooseProject,
  onChooseClip,
  onChooseTrash,
  onCancel,
}: {
  busy: boolean;
  error: string;
  onChooseProject: () => void;
  onChooseClip: () => void;
  onChooseTrash: () => void;
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
          <Icon name="folder" /> Open a project folder
        </button>
        <button className="text-button" onClick={onChooseTrash} disabled={busy}>
          Browse ArtLog trash
        </button>
      </div>
      {error && (
        <p className="error-message welcome-error" role="alert">
          {error}
        </p>
      )}
      <p className="compatibility">
        <Icon name="device" /> Stored on this device
      </p>
    </section>
  );
}

export function ProjectChoices({
  root,
  projects,
  file,
  busy,
  error,
  onOpen,
  onCreate,
  onTrash,
  onBack,
}: {
  root: string;
  projects: ProjectSummary[];
  file?: FileLocation;
  busy: boolean;
  error: string;
  onOpen: (id: string) => void;
  onCreate?: () => void;
  onTrash: () => void;
  onBack: () => void;
}) {
  return (
    <section className="setup-view">
      <button
        className="text-button back-button"
        onClick={onBack}
        disabled={busy}
      >
        <span aria-hidden="true">←</span> Back
      </button>
      <h1>{file ? "Open a .clip file" : "Projects in this folder"}</h1>
      <p className="project-path" title={root}>
        <Icon name="folder" /> <span>{root}</span>
      </p>
      {file && (
        <p>
          ArtLog will track <strong>{file.path}</strong> where it is.{" "}
          {file.shared
            ? "A folder project already tracks this file. The projects will observe the same artwork and have independent histories."
            : "This file will have its own timeline."}
        </p>
      )}
      {projects.length > 0 && (
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
                      ? "Recovered project"
                      : "Folder project"
                    : "Single-file project"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="project-choice-actions">
        {onCreate && (
          <button className="primary-button" disabled={busy} onClick={onCreate}>
            {file ? "Open as a single-file project" : "Set up folder project"}
          </button>
        )}
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
