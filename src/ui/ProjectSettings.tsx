import type {
  ProjectView,
  RepositoryHealth,
  ScanEntry,
  Settings,
} from "../types";
import { formatBytes } from "./format";
import { Icon } from "./Icon";
import "./project-settings.css";

export function FilesView({
  root,
  files,
  settings,
  onGoSettings,
}: {
  root: string;
  files: ScanEntry[];
  settings: Settings;
  onGoSettings: () => void;
}) {
  const tracked = new Set(settings.tracked);
  return (
    <section className="files-view">
      <h2>Files</h2>
      <p className="project-path" title={root}>
        <Icon name="folder" />
        <span>{root}</span>
      </p>
      {files.length === 0 ? (
        <div className="files-empty">
          <Icon name="file" />
          <h3>No .clip files found</h3>
          <p>
            Add artwork to the project folder, then update which files ArtLog
            tracks.
          </p>
        </div>
      ) : (
        <table className="files-table" aria-label="Project files">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => {
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
      <section className="settings-section">
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
      </section>
      <section className="settings-section">
        <h3>Files in history</h3>
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
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <h3>Repository health</h3>
          <button
            type="button"
            className="text-button"
            disabled={healthState === "loading"}
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
          disabled={busy || unchanged}
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
