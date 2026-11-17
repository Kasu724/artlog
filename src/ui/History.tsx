import type { CommitSummary, FileVersion } from "../types";
import { formatBytes, formatDate, isClipFile } from "./format";
import { Icon } from "./Icon";
import "./history.css";

function kindName(kind: CommitSummary["kind"]): string {
  return (
    {
      baseline: "First snapshot",
      auto: "Automatic save",
      checkpoint: "Checkpoint",
      safety: "Safety snapshot",
      restore: "Restored version",
    } as const
  )[kind];
}

export function HistoryTimeline({
  commits,
  selectedId,
  onSelect,
}: {
  commits: CommitSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="timeline-panel" aria-label="Version timeline">
      <h2>History</h2>
      {commits.length === 0 ? (
        <div className="timeline-empty">
          <h3>No snapshots yet</h3>
          <p>Save a named checkpoint to start your project history.</p>
        </div>
      ) : (
        <div className="timeline-scroll">
          <div className="timeline-list">
            {commits.map((commit) => (
              <TimelineEntry
                key={commit.id}
                commit={commit}
                selected={commit.id === selectedId}
                onSelect={() => onSelect(commit.id)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TimelineEntry({
  commit,
  selected,
  onSelect,
}: {
  commit: CommitSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const date = formatDate(commit.timestamp);
  return (
    <button
      className={`timeline-entry ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
      title={commit.title}
    >
      <span className="timeline-node" aria-hidden="true">
        {commit.kind === "safety"
          ? "!"
          : commit.kind === "checkpoint"
            ? "◆"
            : ""}
      </span>
      <span className="timeline-copy">
        <span className="timeline-title">{commit.title}</span>
        <span className="timeline-meta">
          <time dateTime={commit.timestamp} title={date.full}>
            {date.day}, {date.time}
          </time>
          <span className={`timeline-kind kind-${commit.kind}`}>
            {kindName(commit.kind)}
          </span>
        </span>
        <span className="timeline-note">
          {commit.note ||
            `${commit.fileCount} tracked file${commit.fileCount === 1 ? "" : "s"}`}
        </span>
      </span>
    </button>
  );
}

export function VersionDetail({
  commit,
  files,
  selectedPath,
  busy,
  onSelectPath,
  onRestoreCopy,
  onRestoreInPlace,
}: {
  commit: CommitSummary;
  files: FileVersion[];
  selectedPath: string;
  busy: boolean;
  onSelectPath: (path: string) => void;
  onRestoreCopy: () => void;
  onRestoreInPlace: () => void;
}) {
  const date = formatDate(commit.timestamp);
  return (
    <section className="version-card">
      <div className="version-content">
        <h2>{commit.title}</h2>
        <time
          className="detail-date"
          dateTime={commit.timestamp}
          title={date.full}
        >
          {date.day} · {date.time}
        </time>
        {commit.note && <p className="detail-note">{commit.note}</p>}
        {files.length === 0 ? (
          <p className="version-empty">No tracked files in this snapshot.</p>
        ) : (
          <div
            className="version-files"
            role="group"
            aria-label="Files in this version"
          >
            {files.map((file) => (
              <button
                className="version-file"
                key={file.path}
                aria-pressed={selectedPath === file.path}
                onClick={() => onSelectPath(file.path)}
                title={file.path}
              >
                <Icon name="file" />
                <span className="version-file-name">{file.path}</span>
                <span className="version-file-size">
                  {formatBytes(file.size)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="restore-actions">
        <button
          className="primary-button restore-copy"
          disabled={busy || !selectedPath}
          onClick={onRestoreCopy}
        >
          Restore as a copy
        </button>
        {isClipFile(selectedPath) && (
          <button
            className="text-button restore-place"
            disabled={busy || !selectedPath}
            onClick={onRestoreInPlace}
          >
            Replace working file…
          </button>
        )}
      </div>
    </section>
  );
}
