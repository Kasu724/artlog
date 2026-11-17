import type { ScanEntry } from "../types";
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
}: {
  busy: boolean;
  error: string;
  onChooseProject: () => void;
}) {
  return (
    <section className="welcome-layout">
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
      <button
        className="primary-button welcome-action"
        onClick={onChooseProject}
        disabled={busy}
      >
        <Icon name="folder" />{" "}
        <span>{busy ? "Opening folder…" : "Open a project folder"}</span>
      </button>
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
