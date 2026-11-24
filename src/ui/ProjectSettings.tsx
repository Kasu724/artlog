import { useEffect, useId, useState } from "react";
import { artlog } from "../api";
import type {
  CommitThumbnail,
  ProjectFile,
  ProjectView,
  RepackMode,
  RepositoryHealth,
  ScanEntry,
  Settings,
} from "../types";
import { formatBytes, isClipFile } from "./format";
import { Icon } from "./Icon";
import "./project-settings.css";

export type FileActions = {
  viewHistory: (file: ProjectFile) => void;
  stopTracking: (file: ProjectFile) => void;
  deleteHistory: (file: ProjectFile) => void;
  relink: (file: ProjectFile) => void;
};

function ManagedFileActions({
  file,
  actions,
  disabled,
  busy,
  describedBy,
}: {
  file: ProjectFile;
  actions: FileActions;
  disabled: boolean;
  busy: boolean;
  describedBy: string;
}) {
  return (
    <div className="managed-file-actions">
      {file.hasHistory && (
        <button
          type="button"
          className="text-button"
          aria-describedby={describedBy}
          disabled={busy}
          onClick={() => actions.viewHistory(file)}
        >
          View file history
        </button>
      )}
      {file.tracked && (
        <button
          type="button"
          className="quiet-button"
          aria-describedby={describedBy}
          disabled={busy || disabled}
          onClick={() => actions.stopTracking(file)}
        >
          Stop tracking
        </button>
      )}
      {!file.present && (
        <button
          type="button"
          className="quiet-button"
          aria-describedby={describedBy}
          disabled={busy || disabled}
          onClick={() => actions.relink(file)}
        >
          Link renamed file
        </button>
      )}
      {file.hasHistory && (
        <button
          type="button"
          className="quiet-button file-delete-action"
          aria-describedby={describedBy}
          disabled={busy || disabled}
          onClick={() => actions.deleteHistory(file)}
        >
          Delete file history
        </button>
      )}
    </div>
  );
}

function FileTrackingStatus({
  tracked,
  missing,
}: {
  tracked: boolean;
  missing?: boolean;
}) {
  return (
    <div className="file-tracking-status">
      <span className={tracked ? "tracking-on" : "tracking-off"}>
        {tracked ? "Tracked" : "Not tracked"}
      </span>
      {missing && <span className="file-missing">Working file missing</span>}
    </div>
  );
}

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
  const id = useId();
  return (
    <ul className="managed-files">
      {files.map((file, index) => {
        const pathId = `${id}-${index}`;
        return (
          <li key={file.id}>
            <div className="managed-file-description">
              <bdi id={pathId}>{file.path}</bdi>
              <FileTrackingStatus
                tracked={file.tracked}
                missing={!file.present}
              />
            </div>
            <ManagedFileActions
              file={file}
              actions={actions}
              disabled={disabled}
              busy={busy}
              describedBy={pathId}
            />
          </li>
        );
      })}
    </ul>
  );
}

function FileThumbnail({
  projectId,
  file,
}: {
  projectId: string;
  file?: ProjectFile;
}) {
  const fileId = file?.id;
  const path = file?.path;
  const hasHistory = file?.hasHistory;
  const [thumbnail, setThumbnail] = useState<CommitThumbnail | null>(null);
  useEffect(() => {
    if (!hasHistory || !path || !isClipFile(path)) return;
    let active = true;
    void artlog
      .comparisonVersions(projectId, path, fileId)
      .then(([latest]) => {
        if (!active || !latest) return null;
        return artlog.getCommitThumbnail(projectId, latest.id, latest.path);
      })
      .then((preview) => {
        if (active) setThumbnail(preview);
      })
      .catch(() => {
        if (active) setThumbnail(null);
      });
    return () => {
      active = false;
    };
  }, [projectId, path, fileId, hasHistory]);

  return (
    <span className="file-thumbnail">
      {thumbnail ? (
        <img
          src={thumbnail.dataUrl}
          alt={`Saved preview of ${thumbnail.path}`}
          loading="lazy"
          decoding="async"
          onError={() => setThumbnail(null)}
        />
      ) : (
        <span role="img" aria-label="No preview">
          <Icon name="file" />
        </span>
      )}
    </span>
  );
}

export function FilesView({
  project,
  files,
  onGoSettings,
  actions,
  busy,
}: {
  project: ProjectView;
  files: ScanEntry[];
  onGoSettings: () => void;
  actions: FileActions;
  busy: boolean;
}) {
  const registerId = useId();
  const sizes = new Map(files.map(({ path, size }) => [path, size]));
  const knownPaths = new Set(project.files.map(({ path }) => path));
  const tracked = new Set(project.settings.tracked);
  const rows = [
    ...project.files.map((file) => ({
      identity: file,
      path: file.path,
      tracked: file.tracked,
      size: file.present ? sizes.get(file.path) : undefined,
    })),
    ...files
      .filter(({ path }) => !knownPaths.has(path))
      .map(({ path, size }) => ({
        identity: undefined,
        path,
        tracked: tracked.has(path),
        size,
      })),
  ];
  return (
    <section className="files-view" aria-labelledby="files-title">
      <h2 className="page-heading" id="files-title">
        Files
      </h2>
      <div className="files-toolbar">
        <p className="project-path" title={project.root}>
          <Icon name="folder" />
          <span>{project.root}</span>
        </p>
        <button type="button" className="primary-button" onClick={onGoSettings}>
          Manage tracked files
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="files-empty">
          <Icon name="file" />
          <h3>No .clip files found</h3>
          <p>
            Add artwork to the project folder, then update which files ArtLog
            tracks.
          </p>
        </div>
      ) : (
        <div
          className="files-register"
          role="region"
          aria-label="Files register"
          tabIndex={0}
        >
          <table className="files-table" aria-label="Project files">
            <thead>
              <tr>
                <th scope="col">No.</th>
                <th scope="col">Preview</th>
                <th scope="col">File name</th>
                <th scope="col">Status</th>
                <th scope="col">Size</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ identity, path, tracked, size }, index) => {
                const pathId = `${registerId}-${index}`;
                return (
                  <tr key={identity ? `file:${identity.id}` : `path:${path}`}>
                    <td className="register-number">
                      {String(index + 1).padStart(2, "0")}
                    </td>
                    <td>
                      <FileThumbnail
                        key={JSON.stringify([
                          project.id,
                          project.commits[0]?.id,
                          path,
                          identity?.hasHistory,
                        ])}
                        projectId={project.id}
                        file={identity}
                      />
                    </td>
                    <th scope="row" className="files-table-name" title={path}>
                      <bdi id={pathId}>{path}</bdi>
                    </th>
                    <td>
                      <FileTrackingStatus
                        tracked={tracked}
                        missing={identity?.present === false}
                      />
                    </td>
                    <td className="file-size">
                      {size === undefined ? (
                        <span aria-label="Size unavailable">—</span>
                      ) : (
                        formatBytes(size)
                      )}
                    </td>
                    <td>
                      {identity && (
                        <ManagedFileActions
                          file={identity}
                          actions={actions}
                          busy={busy}
                          disabled={!!project.openWarning}
                          describedBy={pathId}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
      <h2 className="page-heading">Settings</h2>
      <fieldset
        className="settings-section settings-fieldset"
        aria-labelledby="automatic-capture-title"
        disabled={busy || !!project.openWarning}
      >
        <h3 id="automatic-capture-title">Automatic capture</h3>
        <div className="capture-settings">
          <label className="setting-toggle">
            <span className="switch-control">
              <input
                type="checkbox"
                aria-label="Automatic capture"
                checked={settings.autoCapture}
                onChange={(event) =>
                  onChange({ ...settings, autoCapture: event.target.checked })
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
      {project.canRepackHistory && (
        <fieldset
          className="settings-section settings-fieldset"
          aria-labelledby="history-storage-title"
          disabled={busy}
        >
          <h3 id="history-storage-title">History storage</h3>
          <div className="storage-settings">
            {!project.openWarning && (
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
          </div>
          {!project.openWarning && (
            <p id="history-compression-help" className="settings-help">
              {project.historyCompression === null
                ? "The compression setting could not be read. Use the switch to reset it."
                : "Use less disk space for new saves when possible. This setting applies immediately."}
            </p>
          )}
          <p className="settings-help">
            Before downgrading ArtLog, convert this history to raw and wait for
            “Raw layout verified.” This turns off compression and can use more
            disk space. If conversion stops, run it again to finish.
          </p>
        </fieldset>
      )}
      <fieldset
        className="settings-section settings-fieldset"
        aria-labelledby="tracked-files-title"
        disabled={busy || !!project.openWarning}
      >
        <h3 id="tracked-files-title">Tracked files</h3>
        <p className="settings-help">
          Choose the files ArtLog tracks. Clearing a checkbox stops future
          capture. Saved versions stay in history.
        </p>
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
                <Icon name="file" />
                <bdi className="settings-file-name">{file.path}</bdi>
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
