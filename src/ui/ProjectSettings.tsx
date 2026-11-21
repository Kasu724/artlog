import { useState } from "react";
import type {
  ProjectFile,
  ProjectView,
  RepackMode,
  RepositoryHealth,
  ScanEntry,
  Settings,
} from "../types";
import { formatBytes } from "./format";
import { Icon } from "./Icon";
import "./project-settings.css";

export type FileActions = {
  viewHistory: (file: ProjectFile) => void;
  stopTracking: (file: ProjectFile) => void;
  deleteHistory: (file: ProjectFile) => void;
  relink: (file: ProjectFile) => void;
};

function ManagedFiles({
  files,
  actions,
  disabled,
  busy,
}: {
  files: ProjectFile[];
  actions: FileActions;
  disabled: boolean;
  busy: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="managed-files">
      {files.map((file) => (
        <li key={file.id}>
          <div>
            <strong>{file.path}</strong>
            <span className="muted-caption">
              {file.tracked ? "Tracked" : "Not tracked"}
              {!file.present && " · Working file missing"}
            </span>
          </div>
          <div className="managed-file-actions">
            {file.hasHistory && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => actions.viewHistory(file)}
              >
                View file history
              </button>
            )}
            {file.tracked && (
              <button
                type="button"
                className="text-button"
                disabled={busy || disabled}
                onClick={() => actions.stopTracking(file)}
              >
                Stop tracking
              </button>
            )}
            {!file.present && (
              <button
                type="button"
                className="text-button"
                disabled={busy || disabled}
                onClick={() => actions.relink(file)}
              >
                Link renamed file
              </button>
            )}
            {file.hasHistory && (
              <button
                type="button"
                className="text-button"
                disabled={busy || disabled}
                onClick={() => actions.deleteHistory(file)}
              >
                Delete file history
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FilesView({
  root,
  files,
  settings,
  onGoSettings,
  identities,
  actions,
  busy,
  readOnly,
}: {
  root: string;
  files: ScanEntry[];
  settings: Settings;
  onGoSettings: () => void;
  identities: ProjectFile[];
  actions: FileActions;
  busy: boolean;
  readOnly: boolean;
}) {
  const tracked = new Set(settings.tracked);
  const unidentified = files.filter(
    (file) => !identities.some((known) => known.path === file.path),
  );
  return (
    <section className="files-view">
      <h2>Files</h2>
      <p className="project-path" title={root}>
        <Icon name="folder" />
        <span>{root}</span>
      </p>
      <ManagedFiles
        files={identities}
        actions={actions}
        busy={busy}
        disabled={readOnly}
      />
      {files.length === 0 && identities.length === 0 ? (
        <div className="files-empty">
          <Icon name="file" />
          <h3>No .clip files found</h3>
          <p>
            Add artwork to the project folder, then update which files ArtLog
            tracks.
          </p>
        </div>
      ) : (
        unidentified.length > 0 && (
          <table className="files-table" aria-label="Project files">
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Status</th>
                <th scope="col">Size</th>
              </tr>
            </thead>
            <tbody>
              {unidentified.map((file) => {
                const isTracked = tracked.has(file.path);
                return (
                  <tr key={file.path}>
                    <td>
                      <span className="files-table-name" title={file.path}>
                        <Icon name="file" />
                        <span>{file.path}</span>
                      </span>
                    </td>
                    <td>
                      <span
                        className={isTracked ? "tracking-on" : "tracking-off"}
                      >
                        {isTracked && <Icon name="check" />}
                        {isTracked ? "Tracked" : "Not tracked"}
                      </span>
                    </td>
                    <td>{formatBytes(file.size)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
      <div className="files-footer">
        <button type="button" className="primary-button" onClick={onGoSettings}>
          Manage tracked files
        </button>
      </div>
    </section>
  );
}

export function SettingsView({
  project,
  settings,
  health,
  healthState,
  healthError,
  busy,
  files,
  onChange,
  onToggle,
  onSave,
  onCheckHealth,
  onCompression,
  onRepack,
  actions,
}: {
  project: ProjectView;
  settings: Settings;
  health: RepositoryHealth | null;
  healthState: "idle" | "loading" | "error";
  healthError: string;
  busy: boolean;
  files: ScanEntry[];
  onChange: (settings: Settings) => void;
  onToggle: (path: string) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onCheckHealth: () => void;
  onCompression: (enabled: boolean) => void;
  onRepack: (mode: RepackMode) => void;
  actions: FileActions;
}) {
  const tracked = new Set(settings.tracked);
  const unchanged =
    settings.autoCapture === project.settings.autoCapture &&
    settings.debounceMs === project.settings.debounceMs &&
    settings.tracked.length === project.settings.tracked.length &&
    settings.tracked.every((path) => project.settings.tracked.includes(path));
  return (
    <form className="settings-view" onSubmit={onSave}>
      <h2>Settings</h2>
      <fieldset
        className="settings-section settings-fieldset"
        disabled={busy || !!project.openWarning}
      >
        <div className="section-heading">
          <h3>Automatic capture</h3>
          <label className="switch-control">
            <input
              type="checkbox"
              aria-label="Automatic capture"
              checked={settings.autoCapture}
              onChange={(event) =>
                onChange({ ...settings, autoCapture: event.target.checked })
              }
            />
            <span aria-hidden="true" />
          </label>
        </div>
        <div className="setting-range">
          <label htmlFor="stability-delay">Save stability delay</label>
          <output htmlFor="stability-delay">
            {(settings.debounceMs / 1000).toFixed(2)} s
          </output>
          <input
            id="stability-delay"
            type="range"
            min={250}
            max={10000}
            step={250}
            value={settings.debounceMs}
            aria-valuetext={`${settings.debounceMs / 1000} seconds`}
            onChange={(event) =>
              onChange({ ...settings, debounceMs: Number(event.target.value) })
            }
          />
          <div className="range-ends" aria-hidden="true">
            <span>250 ms</span>
            <span>10 s</span>
          </div>
        </div>
      </fieldset>
      {project.canRepackHistory && (
        <fieldset
          className="settings-section settings-fieldset"
          disabled={busy}
        >
          <div className="section-heading">
            <h3>History storage</h3>
            {!project.openWarning && (
              <label className="switch-control">
                <input
                  type="checkbox"
                  aria-label="Compress new content objects"
                  aria-describedby="history-compression-help"
                  checked={project.historyCompression === true}
                  onChange={(event) => onCompression(event.target.checked)}
                />
                <span aria-hidden="true" />
              </label>
            )}
          </div>
          {!project.openWarning && (
            <p id="history-compression-help" className="muted-caption">
              {project.historyCompression === null
                ? "The compression setting could not be read. Use the switch to reset it."
                : "Compress new content objects when it saves space. This setting applies immediately."}
            </p>
          )}
          <div className="managed-file-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => onRepack("compress")}
            >
              Compress existing history
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onRepack("raw")}
            >
              Convert history to raw
            </button>
          </div>
          <p className="muted-caption">
            Before downgrading ArtLog, convert this history to raw. This turns
            off compression and can use more disk space. If conversion stops,
            run it again to finish.
          </p>
        </fieldset>
      )}
      <fieldset
        className="settings-section settings-fieldset"
        disabled={busy || !!project.openWarning}
      >
        <h3>Tracked files</h3>
        <div className="settings-files">
          {files.length ? (
            files.map((file) => (
              <label
                className="settings-file"
                key={file.path}
                title={file.path}
              >
                <input
                  aria-label={file.path}
                  type="checkbox"
                  checked={tracked.has(file.path)}
                  onChange={() => onToggle(file.path)}
                />
                <span className="settings-file-name">{file.path}</span>
                <span className="settings-file-size">
                  {formatBytes(file.size)}
                </span>
              </label>
            ))
          ) : (
            <div className="settings-empty">
              No files are currently available in the project folder.
            </div>
          )}
        </div>
        <p className="muted-caption">
          Clearing a checkbox stops future capture. Saved versions stay in
          history.
        </p>
      </fieldset>
      {project.files.length > 0 && (
        <section className="settings-section">
          <h3>File history</h3>
          <ManagedFiles
            files={project.files}
            actions={actions}
            busy={busy}
            disabled={!!project.openWarning}
          />
        </section>
      )}
      <section className="settings-section">
        <div className="section-heading">
          <h3>Repository health</h3>
          <button
            type="button"
            className="text-button"
            disabled={busy || healthState === "loading"}
            onClick={onCheckHealth}
          >
            {healthState === "loading"
              ? "Checking…"
              : health
                ? "Check again"
                : "Check health"}
          </button>
        </div>
        {healthState === "error" && (
          <p className="health-error" role="alert">
            {healthError}
          </p>
        )}
        <dl className="repository-stats">
          <div>
            <dt>Portable history</dt>
            <dd>{formatBytes(project.size)}</dd>
          </div>
          <div>
            <dt>Versions</dt>
            <dd>{health?.versions ?? project.commits.length}</dd>
          </div>
          <div>
            <dt>Content objects</dt>
            <dd>
              {health
                ? health.objects
                : healthState === "loading"
                  ? "…"
                  : "Not checked"}
            </dd>
          </div>
        </dl>
      </section>
      <div className="settings-footer">
        <span className="settings-save-status" role="status">
          {unchanged && <Icon name="check" />}
          {unchanged ? "No unsaved changes" : "Unsaved settings"}
        </span>
        <button
          className="primary-button compact-button"
          disabled={busy || unchanged || !!project.openWarning}
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

export function ProjectOptions({
  project,
  busy,
  onRename,
  onRemove,
  onTrash,
}: {
  project: ProjectView;
  busy: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
  onTrash: () => void;
}) {
  const [name, setName] = useState(project.name);
  return (
    <section className="settings-section project-options">
      <h3>Project management</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onRename(name.trim());
        }}
      >
        <label>
          Project name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            disabled={busy || !!project.openWarning}
          />
        </label>
        <button
          type="submit"
          className="secondary-button"
          disabled={
            busy ||
            !!project.openWarning ||
            !name.trim() ||
            name.trim() === project.name
          }
        >
          Rename project
        </button>
      </form>
      <div className="managed-file-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onTrash}
        >
          View ArtLog trash
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={busy || !!project.openWarning}
          onClick={onRemove}
        >
          Remove project
        </button>
      </div>
    </section>
  );
}
