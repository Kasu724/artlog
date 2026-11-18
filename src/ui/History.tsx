import { useEffect, useRef, useState } from "react";
import { artlog } from "../api";
import type { CommitSummary, CommitThumbnail, FileVersion } from "../types";
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
  projectId,
  previewRevision = 0,
  commits,
  scopedPaths,
  scopeName,
  loadingScope = false,
  onClearScope,
  selectedId,
  onSelect,
}: {
  projectId: string;
  previewRevision?: number;
  commits: CommitSummary[];
  scopedPaths?: Record<string, string>;
  scopeName?: string;
  loadingScope?: boolean;
  onClearScope?: () => void;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="timeline-panel" aria-label="Version timeline">
      <h2>History</h2>
      {scopeName && (
        <div className="history-scope">
          <span title={scopeName}>{scopeName}</span>
          <button className="text-button" onClick={onClearScope}>
            Show project timeline
          </button>
        </div>
      )}
      {loadingScope ? (
        <p className="muted-caption" role="status">
          Loading file history…
        </p>
      ) : commits.length === 0 ? (
        <div className="timeline-empty">
          <h3>No snapshots yet</h3>
          <p>Save a named checkpoint to start your project history.</p>
        </div>
      ) : (
        <div className="timeline-scroll">
          <div className="timeline-list">
            {commits.map((commit) => (
              <TimelineEntry
                key={`${projectId}:${commit.id}`}
                projectId={projectId}
                previewRevision={previewRevision}
                commit={commit}
                path={scopedPaths?.[commit.id]}
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
  projectId,
  previewRevision,
  commit,
  path,
  selected,
  onSelect,
}: {
  projectId: string;
  previewRevision: number;
  commit: CommitSummary;
  path?: string;
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
        <TimelineThumbnail
          key={`${previewRevision}:${path ?? ""}`}
          projectId={projectId}
          commit={commit}
          path={path}
          previewRevision={previewRevision}
        />
      </span>
    </button>
  );
}

function TimelineThumbnail({
  projectId,
  commit,
  path,
  previewRevision,
}: {
  projectId: string;
  commit: CommitSummary;
  path?: string;
  previewRevision: number;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [thumbnail, setThumbnail] = useState<CommitThumbnail | null>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void artlog
        .getCommitThumbnail(projectId, commit.id, path)
        .then((preview) => {
          if (active) setThumbnail(preview);
        })
        .catch(() => {
          if (active) setThumbnail(null);
        });
    };

    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                load();
                observer?.disconnect();
              }
            },
            {
              root: container.closest(".timeline-scroll"),
              rootMargin: "120px",
            },
          );
    if (observer) observer.observe(container);
    else load();

    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [projectId, commit.id, previewRevision, path]);

  return (
    <span className="timeline-thumbnail" ref={containerRef}>
      {thumbnail ? (
        <img
          src={thumbnail.dataUrl}
          alt={`Thumbnail of ${thumbnail.path} for ${commit.title}`}
          title={thumbnail.path}
          width={thumbnail.width}
          height={thumbnail.height}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setThumbnail(null)}
        />
      ) : (
        <span
          className="timeline-thumbnail-placeholder"
          role="img"
          aria-label={`${thumbnail === null ? "Thumbnail unavailable" : "Loading thumbnail"} for ${commit.title}`}
        >
          <Icon name="file" />
          <span>{thumbnail === null ? "No thumbnail" : "Loading…"}</span>
        </span>
      )}
    </span>
  );
}

export function VersionDetail({
  commit,
  files,
  selectedPath,
  busy,
  canReplace = true,
  onSelectPath,
  onRestoreCopy,
  onRestoreInPlace,
}: {
  commit: CommitSummary;
  files: FileVersion[];
  selectedPath: string;
  busy: boolean;
  canReplace?: boolean;
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
        {isClipFile(selectedPath) && canReplace && (
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
