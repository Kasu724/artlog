import { useEffect, useRef, useState, type ReactNode } from "react";
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
  comparisonCandidates = null,
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
  comparisonCandidates?: string[] | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section
      className={`timeline-panel${comparisonCandidates ? " choosing-comparison" : ""}`}
      aria-label="Version timeline"
    >
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
                comparisonCandidate={comparisonCandidates?.includes(commit.id)}
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
  comparisonCandidate,
  onSelect,
}: {
  projectId: string;
  previewRevision: number;
  commit: CommitSummary;
  path?: string;
  selected: boolean;
  comparisonCandidate?: boolean;
  onSelect: () => void;
}) {
  const date = formatDate(commit.timestamp);
  return (
    <button
      className={`timeline-entry${selected ? " selected" : ""}${comparisonCandidate ? " comparison-candidate" : ""}`}
      disabled={comparisonCandidate === false}
      aria-pressed={selected}
      onClick={onSelect}
      title={commit.title}
    >
      <TimelineThumbnail
        key={`${previewRevision}:${path ?? ""}`}
        projectId={projectId}
        commit={commit}
        path={path}
        previewRevision={previewRevision}
      />
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
  children,
}: {
  commit: CommitSummary;
  files: FileVersion[];
  selectedPath: string;
  busy: boolean;
  canReplace?: boolean;
  onSelectPath: (path: string) => void;
  onRestoreCopy: () => void;
  onRestoreInPlace: () => void;
  children?: ReactNode;
}) {
  const date = formatDate(commit.timestamp);
  const onlyFile = files.length === 1 ? files[0] : null;
  return (
    <section className="version-card">
      <div className="version-content">
        <div className="version-heading">
          <h3>{commit.title}</h3>
          <span className={`version-kind kind-${commit.kind}`}>
            {kindName(commit.kind)}
          </span>
        </div>
        <div className="version-meta">
          <time dateTime={commit.timestamp} title={date.full}>
            {date.day} · {date.time}
          </time>
          {onlyFile && (
            <span className="version-meta-file" title={onlyFile.path}>
              <Icon name="file" />
              <bdi className="version-file-name">{onlyFile.path}</bdi>
              <span className="version-file-size">
                {formatBytes(onlyFile.size)}
              </span>
            </span>
          )}
        </div>
        {commit.note && (
          <p className="detail-note">
            <Icon name="file" />
            <span>{commit.note}</span>
          </p>
        )}
        {files.length === 0 ? (
          <p className="version-empty">No tracked files in this snapshot.</p>
        ) : !onlyFile ? (
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
        ) : null}
      </div>
      {children}
      <div className="restore-actions">
        {isClipFile(selectedPath) && canReplace && (
          <button
            className="quiet-button restore-place"
            disabled={busy || !selectedPath}
            onClick={onRestoreInPlace}
          >
            Replace working file…
          </button>
        )}
        <button
          className="primary-button restore-copy"
          disabled={busy || !selectedPath}
          onClick={onRestoreCopy}
        >
          Restore as a copy
        </button>
      </div>
    </section>
  );
}
