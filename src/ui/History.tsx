import { useEffect, useRef, useState, type ReactNode } from "react";
import { artlog } from "../api";
import type { CommitSummary, CommitThumbnail, FileVersion } from "../types";
import { formatBytes, formatDate } from "./format";
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
  commits,
  selectedId,
  comparisonCandidates = null,
  onSelect,
  onEdit,
  editDisabled,
}: {
  projectId: string;
  commits: CommitSummary[];
  selectedId: string;
  comparisonCandidates?: string[] | null;
  onSelect: (id: string) => void;
  onEdit?: (commit: CommitSummary) => void;
  editDisabled?: boolean;
}) {
  return (
    <section
      className={`timeline-panel${comparisonCandidates ? " choosing-comparison" : ""}`}
      aria-label="Version timeline"
    >
      {commits.length === 0 ? (
        <div className="timeline-empty">
          <h3>No snapshots yet</h3>
          <p>Save your .clip file in Clip Studio Paint to capture a version.</p>
        </div>
      ) : (
        <div className="timeline-scroll">
          <div className="timeline-list">
            {commits.map((commit) => (
              <div
                className="timeline-row"
                data-current={commit.id === selectedId}
                key={`${projectId}:${commit.id}`}
              >
                <span className="timeline-dot" aria-hidden="true" />
                <TimelineEntry
                  projectId={projectId}
                  commit={commit}
                  selected={commit.id === selectedId}
                  comparisonCandidate={comparisonCandidates?.includes(
                    commit.id,
                  )}
                  onSelect={() => onSelect(commit.id)}
                />
                {onEdit && (
                  <button
                    type="button"
                    className="quiet-button timeline-edit"
                    aria-label={`Edit version details for ${commit.title}`}
                    title="Edit title and notes"
                    disabled={editDisabled || comparisonCandidates !== null}
                    onClick={() => onEdit(commit)}
                  >
                    <svg
                      className="icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.65"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m15 5 4 4M4 20l4.5-1 12-12-3.5-3.5-12 12L4 20Z" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TimelineEntry({
  projectId,
  commit,
  selected,
  comparisonCandidate,
  onSelect,
}: {
  projectId: string;
  commit: CommitSummary;
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
      <TimelineThumbnail projectId={projectId} commit={commit} />
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
        {commit.note && <span className="timeline-note">{commit.note}</span>}
      </span>
    </button>
  );
}

function TimelineThumbnail({
  projectId,
  commit,
}: {
  projectId: string;
  commit: CommitSummary;
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
        .getCommitThumbnail(projectId, commit.id)
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
  }, [projectId, commit.id]);

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
  file,
  folderPath,
  loading,
  busy,
  canReplace,
  onRestoreCopy,
  onRestoreInPlace,
  children,
}: {
  commit: CommitSummary;
  file: FileVersion | null;
  folderPath: string;
  loading: boolean;
  busy: boolean;
  canReplace: boolean;
  onRestoreCopy: () => void;
  onRestoreInPlace: () => void;
  children?: ReactNode;
}) {
  const date = formatDate(commit.timestamp);
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
          {file && (
            <span className="version-meta-file" title={file.path}>
              <Icon name="file" />
              <bdi className="version-file-name">{file.path}</bdi>
              <span className="version-file-size">
                {formatBytes(file.size)}
              </span>
            </span>
          )}
          <span className="project-path version-folder-path" title={folderPath}>
            <Icon name="folder" />
            <span>{folderPath}</span>
          </span>
        </div>
        {commit.note && (
          <p className="detail-note">
            <Icon name="file" />
            <span>{commit.note}</span>
          </p>
        )}
        {!file && (
          <p className="version-empty" role={loading ? "status" : undefined}>
            {loading
              ? "Loading version…"
              : "This version has no saved copy of the file."}
          </p>
        )}
      </div>
      {children}
      <div className="restore-actions">
        {file && canReplace && (
          <button
            type="button"
            className="secondary-button restore-place"
            disabled={busy}
            onClick={onRestoreInPlace}
          >
            Replace working file…
          </button>
        )}
        <button
          className="primary-button restore-copy"
          disabled={busy || !file}
          onClick={onRestoreCopy}
        >
          Restore as a copy
        </button>
      </div>
    </section>
  );
}
