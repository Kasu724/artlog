import { useState } from "react";
import type {
  ProjectFile,
  ProjectView,
  RepackMode,
  RepositoryHealth,
  Settings,
} from "../types";
import { formatBytes } from "./format";
import { Icon } from "./Icon";
import "./project-settings.css";

export function SettingsView({
  project,
  settings,
  health,
  healthState,
  healthError,
  busy,
  onChange,
  onSave,
  onCheckHealth,
  onCompression,
  onRepack,
}: {
  project: ProjectView;
  settings: Settings;
  health: RepositoryHealth | null;
  healthState: "idle" | "loading" | "error";
  healthError: string;
  busy: boolean;
  onChange: (settings: Settings) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onCheckHealth: () => void;
  onCompression: (enabled: boolean) => void;
  onRepack: (mode: RepackMode) => void;
}) {
  const path = project.project.path;
  const capturesSaves =
    settings.autoCapture && !!path && settings.tracked.includes(path);
  const unchanged =
    settings.autoCapture === project.settings.autoCapture &&
    settings.debounceMs === project.settings.debounceMs &&
    settings.tracked.length === project.settings.tracked.length &&
    settings.tracked.every((path) => project.settings.tracked.includes(path));
  return (
    <form className="settings-view" onSubmit={onSave}>
      <h2 className="page-heading">Settings</h2>
      <fieldset
        className="settings-section settings-fieldset"
        aria-labelledby="automatic-capture-title"
        disabled={busy}
      >
        <h3 id="automatic-capture-title">Automatic capture</h3>
        <div className="capture-settings">
          <label className="setting-toggle">
            <span className="switch-control">
              <input
                type="checkbox"
                aria-label="Automatic capture"
                checked={capturesSaves}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    autoCapture: event.target.checked,
                    tracked:
                      event.target.checked && path ? [path] : settings.tracked,
                  })
                }
              />
              <span aria-hidden="true" />
            </span>
            Capture stable saves automatically
          </label>
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
                onChange({
                  ...settings,
                  debounceMs: Number(event.target.value),
                })
              }
            />
            <div className="range-ends" aria-hidden="true">
              <span>250 ms</span>
              <span>10 s</span>
            </div>
          </div>
        </div>
      </fieldset>
      <fieldset
        className="settings-section settings-fieldset"
        aria-labelledby="history-storage-title"
        disabled={busy}
      >
        <h3 id="history-storage-title">History storage</h3>
        <div className="storage-settings">
          <label className="setting-toggle">
            <span className="switch-control">
              <input
                type="checkbox"
                aria-describedby="history-compression-help"
                checked={project.historyCompression === true}
                onChange={(event) => onCompression(event.target.checked)}
              />
              <span aria-hidden="true" />
            </span>
            Compress new content objects
          </label>
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
        </div>
        <p id="history-compression-help" className="settings-help">
          {project.historyCompression === null
            ? "The compression setting could not be read. Use the switch to reset it."
            : "Use less disk space for new saves when possible. This setting applies immediately."}
        </p>
        <p className="settings-help">
          Before downgrading ArtLog, convert this history to raw and wait for
          “Raw layout verified.” This turns off compression and can use more
          disk space. If conversion stops, run it again to finish.
        </p>
      </fieldset>
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
            <dd title="Disk space used by saved history">
              {formatBytes(project.size)}
            </dd>
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

export function ProjectOptions({
  project,
  busy,
  onRename,
  workingFile,
  onRelink,
  onDelete,
}: {
  project: ProjectView;
  busy: boolean;
  onRename: (name: string) => void;
  workingFile?: ProjectFile;
  onRelink: (file: ProjectFile) => void;
  onDelete: () => void;
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
            disabled={busy}
          />
        </label>
        <button
          type="submit"
          className="secondary-button"
          disabled={busy || !name.trim() || name.trim() === project.name}
        >
          Rename project
        </button>
      </form>
      {workingFile && !workingFile.present && (
        <div className="working-file-missing">
          <p className="settings-help">
            The working file is missing from its original folder.
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || project.recoveryPaths.length > 0}
            onClick={() => onRelink(workingFile)}
          >
            Link renamed file
          </button>
        </div>
      )}
      <button
        type="button"
        className="quiet-button file-delete-action"
        disabled={
          busy || !project.project.path || project.recoveryPaths.length > 0
        }
        onClick={onDelete}
      >
        Delete file history
      </button>
    </section>
  );
}
