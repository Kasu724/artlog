import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { artlog } from "../api";
import type {
  CaptureStatus,
  CommitSummary,
  FileVersion,
  ProjectView,
  RepositoryHealth,
  RestoreOutcome,
  Preview,
  ScanEntry,
  Settings,
  ViewName,
} from "../types";
import { Icon } from "./Icon";
import { HistoryTimeline, VersionDetail } from "./History";
import { createPixelDifference } from "./pixel-difference";
import { TrackSetup, Welcome, type Setup } from "./ProjectEntry";
import { fileName, formatBytes, formatDate, isClipFile } from "./format";

function errorMessage(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return "ArtLog could not complete that action. Try again, and keep the original file safe.";
}

function statusName(status: CaptureStatus["state"]): string {
  return (
    {
      pending: "Changes pending",
      capturing: "Saving a snapshot",
      current: "Up to date",
      paused: "Capture paused",
      error: "Capture needs attention",
    } as const
  )[status];
}

function joinPath(root: string, ...parts: string[]): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return [root.replace(/[\\/]+$/, ""), ...parts].join(separator);
}

type PreviewLoad =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "error"; message: string }
  | { state: "ready"; preview: Preview };

function usePreview(projectId: string, commitId: string, path: string) {
  const key = `${projectId}\0${commitId}\0${path}`;
  const [stored, setStored] = useState<{ key: string; result: PreviewLoad }>({
    key: "",
    result: { state: "loading" },
  });
  const result =
    stored.key === key ? stored.result : { state: "loading" as const };
  const generation = useRef(0);
  const activeKey = useRef(key);
  const mounted = useRef(true);
  activeKey.current = key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [retry, setRetry] = useState(0);
  const update = useCallback(
    (next: PreviewLoad) => setStored({ key, result: next }),
    [key],
  );
  useEffect(() => {
    const token = ++generation.current;
    if (!projectId || !commitId || !path) {
      update({ state: "unavailable" });
      return () => {
        generation.current += 1;
      };
    }
    update({ state: "loading" });
    void artlog
      .getPreview(projectId, commitId, path)
      .then((preview) => {
        if (generation.current === token)
          update(
            preview ? { state: "ready", preview } : { state: "unavailable" },
          );
      })
      .catch((cause) => {
        if (generation.current === token)
          update({ state: "error", message: errorMessage(cause) });
      });
    return () => {
      generation.current += 1;
    };
  }, [projectId, commitId, path, retry, update]);
  const attach = async (imagePath: string) => {
    const requestedKey = key;
    if (!mounted.current || activeKey.current !== requestedKey) return;
    const token = generation.current;
    update({ state: "loading" });
    try {
      const preview = await artlog.attachPreview(
        projectId,
        commitId,
        path,
        imagePath,
      );
      if (
        mounted.current &&
        activeKey.current === requestedKey &&
        generation.current === token
      )
        update({ state: "ready", preview });
    } catch (cause) {
      if (
        mounted.current &&
        activeKey.current === requestedKey &&
        generation.current === token
      )
        update({ state: "error", message: errorMessage(cause) });
    }
  };
  return { result, retry: () => setRetry((value) => value + 1), attach };
}

function PreviewComparison({
  projectId,
  currentCommit,
  commits,
  path,
}: {
  projectId: string;
  currentCommit: CommitSummary;
  commits: CommitSummary[];
  path: string;
}) {
  const current = usePreview(projectId, currentCommit.id, path);
  const [compareId, setCompareId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [candidates, setCandidates] = useState<CommitSummary[] | null>(null);
  const [candidateState, setCandidateState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [candidateError, setCandidateError] = useState("");
  const [candidateRetry, setCandidateRetry] = useState(0);
  const comparisonCommit = commits.find((commit) => commit.id === compareId);
  const comparison = usePreview(projectId, comparisonCommit?.id ?? "", path);
  const [mode, setMode] = useState<"side" | "overlay" | "difference">("side");
  const [opacity, setOpacity] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStart = useRef<{
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [difference, setDifference] = useState<{
    dataUrl: string;
    width: number;
    height: number;
  } | null>(null);
  const [differenceState, setDifferenceState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [differenceError, setDifferenceError] = useState("");
  const [attachError, setAttachError] = useState("");

  const sameDimensions =
    current.result.state === "ready" &&
    comparison.result.state === "ready" &&
    current.result.preview.width === comparison.result.preview.width &&
    current.result.preview.height === comparison.result.preview.height;
  const anyPreview =
    current.result.state === "ready" || comparison.result.state === "ready";

  useEffect(() => {
    if (!pickerOpen || candidates !== null) return;
    let active = true;
    setCandidateState("loading");
    setCandidateError("");
    void artlog
      .comparisonVersions(projectId, path)
      .then((ids) => {
        if (!active) return;
        setCandidates(
          ids
            .filter((id) => id !== currentCommit.id)
            .map((id) => commits.find((commit) => commit.id === id))
            .filter((commit): commit is CommitSummary => commit !== undefined),
        );
        setCandidateState("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setCandidateError(errorMessage(cause));
        setCandidateState("error");
      });
    return () => {
      active = false;
    };
  }, [
    pickerOpen,
    candidates,
    commits,
    currentCommit.id,
    projectId,
    path,
    candidateRetry,
  ]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setMode("side");
    setDifference(null);
    setDifferenceState("idle");
  }, [compareId, path, currentCommit.id]);

  useEffect(() => {
    if (
      mode !== "difference" ||
      !sameDimensions ||
      current.result.state !== "ready" ||
      comparison.result.state !== "ready"
    ) {
      if (mode === "difference" && !sameDimensions) setMode("side");
      return;
    }
    let active = true;
    setDifferenceState("loading");
    setDifferenceError("");
    void createPixelDifference(
      current.result.preview,
      comparison.result.preview,
    )
      .then((result) => {
        if (active) {
          setDifference(result);
          setDifferenceState("idle");
        }
      })
      .catch((cause) => {
        if (!active) return;
        setDifferenceError(errorMessage(cause));
        setDifferenceState("error");
      });
    return () => {
      active = false;
    };
  }, [mode, sameDimensions, current.result, comparison.result]);

  async function attachExport(
    commit: CommitSummary,
    pane: ReturnType<typeof usePreview>,
  ) {
    setAttachError("");
    try {
      const imagePath = await open({
        title: `Attach a flattened export for ${commit.title} · ${path}`,
        multiple: false,
        filters: [
          { name: "PNG or JPEG preview", extensions: ["png", "jpg", "jpeg"] },
        ],
      });
      if (typeof imagePath === "string") await pane.attach(imagePath);
    } catch (cause) {
      setAttachError(errorMessage(cause));
    }
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }
  function zoomBy(amount: number) {
    setZoom((value) =>
      Math.max(1, Math.min(5, Number((value + amount).toFixed(2)))),
    );
  }
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(0.15);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(-0.15);
    } else if (event.key === "0") {
      event.preventDefault();
      resetView();
    } else if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown"
    ) {
      event.preventDefault();
      setPan((value) => ({
        x:
          value.x +
          (event.key === "ArrowLeft"
            ? 30
            : event.key === "ArrowRight"
              ? -30
              : 0),
        y:
          value.y +
          (event.key === "ArrowUp" ? 30 : event.key === "ArrowDown" ? -30 : 0),
      }));
    }
  }
  function pointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panStart.current = {
      x: event.clientX,
      y: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
  }
  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!panStart.current) return;
    setPan({
      x: panStart.current.originX + event.clientX - panStart.current.x,
      y: panStart.current.originY + event.clientY - panStart.current.y,
    });
  }
  function pointerUp() {
    panStart.current = null;
  }
  function wheel(event: React.WheelEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 0.1 : -0.1);
    }
  }

  return (
    <section className="compare-panel" aria-label="Preview comparison">
      <div className="section-heading compare-heading">
        <div>
          <div className="eyebrow">
            VISUAL CHECK · {fileName(path) || "NO FILE SELECTED"}
          </div>
          <h3>Compare versions</h3>
        </div>
        <button
          className="text-button"
          disabled={!path}
          onClick={() => {
            setPickerOpen((value) => !value);
            setCandidateState("idle");
            setCandidates(null);
            setCandidateError("");
          }}
        >
          {pickerOpen ? "Close compare" : "Compare with another version…"}
        </button>
      </div>
      {pickerOpen && (
        <div className="compare-picker">
          {candidateState === "loading" ? (
            <span className="muted-caption">
              Finding versions containing this file…
            </span>
          ) : candidateState === "error" ? (
            <div className="compare-error" role="alert">
              {candidateError}
              <button
                className="text-button"
                onClick={() => {
                  setCandidates(null);
                  setCandidateState("idle");
                  setCandidateRetry((value) => value + 1);
                }}
              >
                Retry
              </button>
            </div>
          ) : candidates?.length ? (
            <label>
              Compare <span className="sr-only">{path}</span> with
              <select
                aria-label="Compare with version"
                value={compareId}
                onChange={(event) => {
                  setCompareId(event.target.value);
                  resetView();
                }}
              >
                <option value="">Choose an earlier version</option>
                {candidates.map((commit) => (
                  <option key={commit.id} value={commit.id}>
                    {commit.title} · {formatDate(commit.timestamp).day}
                  </option>
                ))}
              </select>
            </label>
          ) : candidateState === "ready" ? (
            <span className="muted-caption">
              No other version contains {path}.
            </span>
          ) : (
            <span className="muted-caption">
              Choose a version of this file to compare.
            </span>
          )}
        </div>
      )}
      <div className="compare-version-labels">
        <span>
          EARLIER VERSION
          {comparisonCommit ? ` · ${comparisonCommit.title}` : ""}
        </span>
        <span>SELECTED VERSION · {currentCommit.title}</span>
      </div>
      {mode === "overlay" &&
      sameDimensions &&
      current.result.state === "ready" &&
      comparison.result.state === "ready" ? (
        <div
          className="comparison-stage overlay-stage"
          tabIndex={0}
          role="img"
          aria-label="Overlay preview comparison. Use arrow keys to pan, plus and minus to zoom, and zero to reset."
          onKeyDown={onKeyDown}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          onWheel={wheel}
        >
          <div
            className="comparison-image-transform"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            <img
              src={comparison.result.preview.dataUrl}
              alt={`Earlier version of ${path}`}
            />
            <img
              src={current.result.preview.dataUrl}
              alt=""
              style={{ opacity: opacity / 100 }}
            />
          </div>
        </div>
      ) : mode === "difference" && difference ? (
        <div
          className="comparison-stage"
          tabIndex={0}
          role="img"
          aria-label="Pixel difference preview. Black pixels match; colored pixels differ."
          onKeyDown={onKeyDown}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          onWheel={wheel}
        >
          <img
            className="difference-image"
            src={difference.dataUrl}
            alt={`Pixel difference between ${currentCommit.title} and ${comparisonCommit?.title}`}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          />
        </div>
      ) : (
        <div className="compare-slots">
          <PreviewPane
            label="EARLIER VERSION"
            path={path}
            commit={comparisonCommit}
            state={comparison.result}
            loading={comparison.result.state === "loading"}
            onRetry={comparison.retry}
            onAttach={() =>
              comparisonCommit &&
              void attachExport(comparisonCommit, comparison)
            }
            zoom={zoom}
            pan={pan}
            onKeyDown={onKeyDown}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onWheel={wheel}
          />
          <PreviewPane
            label="SELECTED VERSION"
            path={path}
            commit={currentCommit}
            state={current.result}
            loading={current.result.state === "loading"}
            onRetry={current.retry}
            onAttach={() => void attachExport(currentCommit, current)}
            zoom={zoom}
            pan={pan}
            onKeyDown={onKeyDown}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onWheel={wheel}
          />
        </div>
      )}
      {comparisonCommit && (
        <div className="preview-controls-row">
          <div
            className="preview-pan-controls"
            role="group"
            aria-label="Synchronized zoom and pan controls"
          >
            <button
              aria-label="Zoom out"
              onClick={() => zoomBy(-0.15)}
              disabled={zoom <= 1}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label="Zoom in"
              onClick={() => zoomBy(0.15)}
              disabled={zoom >= 5}
            >
              ＋
            </button>
            <button aria-label="Reset zoom and pan" onClick={resetView}>
              Reset
            </button>
          </div>
          {current.result.state === "ready" &&
            comparison.result.state === "ready" && (
              <div
                className="compare-modes"
                role="group"
                aria-label="Comparison mode"
              >
                <button
                  className={mode === "side" ? "active" : ""}
                  onClick={() => setMode("side")}
                >
                  Side by side
                </button>
                <button
                  className={mode === "overlay" ? "active" : ""}
                  disabled={!sameDimensions}
                  onClick={() => setMode("overlay")}
                >
                  Overlay
                </button>
                <button
                  className={mode === "difference" ? "active" : ""}
                  disabled={!sameDimensions}
                  onClick={() => setMode("difference")}
                >
                  Difference
                </button>
              </div>
            )}
        </div>
      )}
      {mode === "overlay" && sameDimensions && (
        <label className="opacity-control">
          Selected version opacity{" "}
          <input
            type="range"
            min="0"
            max="100"
            value={opacity}
            onChange={(event) => setOpacity(Number(event.target.value))}
          />
          <span>{opacity}%</span>
        </label>
      )}
      {attachError && (
        <p className="compare-error" role="alert">
          {attachError}
        </p>
      )}
      {mode === "difference" && differenceState === "loading" && (
        <p className="muted-caption" role="status">
          Calculating pixel differences at up to 1024 pixels per edge…
        </p>
      )}
      {mode === "difference" && differenceState === "error" && (
        <p className="compare-error" role="alert">
          {differenceError}
        </p>
      )}
      {comparisonCommit &&
        !sameDimensions &&
        current.result.state === "ready" &&
        comparison.result.state === "ready" && (
          <p className="muted-caption">
            Overlay and pixel difference need previews with matching dimensions
            ({current.result.preview.width} × {current.result.preview.height}{" "}
            and {comparison.result.preview.width} ×{" "}
            {comparison.result.preview.height}).
          </p>
        )}
      {anyPreview && (
        <p className="muted-caption">
          Use pointer drag or the arrow keys to pan; hold Ctrl or Command while
          scrolling to zoom. Press 0 to reset.
        </p>
      )}
      <p className="muted-caption">
        Previews are separate from the source files. Exact-byte history and
        restore remain available if a preview cannot be read.
      </p>
    </section>
  );
}

function PreviewPane({
  label,
  path,
  commit,
  state,
  loading,
  onRetry,
  onAttach,
  zoom,
  pan,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
}: {
  label: string;
  path: string;
  commit: CommitSummary | undefined;
  state: PreviewLoad;
  loading: boolean;
  onRetry: () => void;
  onAttach: () => void;
  zoom: number;
  pan: { x: number; y: number };
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
}) {
  const adapterNote =
    state.state === "ready"
      ? `Artist-provided PNG/JPEG export · approximate visual reference · ${state.preview.width} × ${state.preview.height}`
      : "";
  return (
    <div className="preview-pane">
      <span className="preview-card-label">
        {label}
        {commit ? ` · ${formatDate(commit.timestamp).day}` : ""}
      </span>
      {loading ? (
        <div className="preview-state" role="status">
          Loading preview…
        </div>
      ) : state.state === "ready" ? (
        <div
          className="preview-thumb-stage"
          tabIndex={0}
          role="img"
          aria-label={`${label.toLowerCase()} preview of ${path}; use arrow keys to pan, plus and minus to zoom, and zero to reset`}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        >
          <img
            draggable={false}
            className="preview-thumbnail"
            src={state.preview.dataUrl}
            alt=""
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          />
        </div>
      ) : state.state === "error" ? (
        <div className="preview-state preview-state-error" role="alert">
          <span>Preview unavailable</span>
          <small>{state.message}</small>
          <button className="text-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : (
        <div className="preview-state">
          <span className={`file-glyph ${isClipFile(path) ? "artwork" : ""}`}>
            {isClipFile(path) ? "CLIP" : "FILE"}
          </span>
          <span>
            {commit
              ? "No preview saved for this version"
              : "Choose an earlier version"}
          </span>
        </div>
      )}
      {adapterNote && (
        <span
          className="preview-provenance"
          title={
            state.state === "ready"
              ? String(state.preview.adapterVersion)
              : undefined
          }
        >
          {adapterNote}
        </span>
      )}
      {commit && state.state !== "ready" && (
        <span className="attach-preview-note">
          Attach a PNG or JPEG export from Clip Studio Paint as an approximate
          visual reference. The source file stays unchanged.
        </span>
      )}
      {commit && isClipFile(path) && (
        <button
          className="text-button attach-preview"
          onClick={onAttach}
          disabled={loading}
          title={`Attach a flattened PNG or JPEG export as an approximate reference for ${commit.title}, ${path}`}
        >
          {state.state === "ready"
            ? "Replace attached preview…"
            : "Attach PNG/JPEG export…"}
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [project, setProject] = useState<ProjectView | null>(null);
  const [view, setView] = useState<ViewName>("history");
  const [selectedId, setSelectedId] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<FileVersion[]>([]);
  const [workingFiles, setWorkingFiles] = useState<ScanEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [health, setHealth] = useState<RepositoryHealth | null>(null);
  const [healthState, setHealthState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [healthError, setHealthError] = useState("");
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [checkpointTitle, setCheckpointTitle] = useState("");
  const [checkpointNote, setCheckpointNote] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<{
    id: string;
    file: FileVersion;
  } | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreOutcome | null>(
    null,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const checkpointDialogRef = useRef<HTMLDialogElement>(null);
  const projectSnapshotRef = useRef<ProjectView | null>(null);
  projectSnapshotRef.current = project;

  const selectedCommit = useMemo(
    () =>
      project?.commits.find((commit) => commit.id === selectedId) ??
      project?.commits[0] ??
      null,
    [project, selectedId],
  );

  const projectId = project?.id;
  const refreshProject = useCallback(
    async (keepSelection = true, syncSettings = true) => {
      if (!projectId) return null;
      const next = await artlog.projectView(projectId);
      setProject(next);
      if (syncSettings) setSettingsDraft(next.settings);
      setSelectedId((previous) =>
        keepSelection && next.commits.some((commit) => commit.id === previous)
          ? previous
          : (next.commits[0]?.id ?? ""),
      );
      return next;
    },
    [projectId],
  );

  const loadProjectFiles = useCallback(async (id: string) => {
    try {
      setWorkingFiles(await artlog.projectFiles(id));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  async function checkRepositoryHealth(id: string) {
    setHealthState("loading");
    setHealthError("");
    try {
      setHealth(await artlog.repositoryHealth(id));
      setHealthState("idle");
    } catch (cause) {
      setHealth(null);
      setHealthError(errorMessage(cause));
      setHealthState("error");
    }
  }

  async function activate(root: string, tracked: string[] | null) {
    setBusy(true);
    setError("");
    try {
      const next = await artlog.activateProject(root, tracked);
      setProject(next);
      setSettingsDraft(next.settings);
      setSelectedId(next.commits[0]?.id ?? "");
      setSelectedFiles([]);
      setSelectedPath("");
      setSetup(null);
      setView("history");
      setCapture(next.capture ?? null);
      setHealth(null);
      setHealthState("idle");
      setHealthError("");
      await loadProjectFiles(next.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function chooseProject() {
    setError("");
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Choose an art project folder",
      });
      if (typeof path !== "string") return;
      setBusy(true);
      const scan = await artlog.scanProject(path);
      if (scan.exists) {
        await activate(path, null);
      } else {
        const initial = scan.files.map((file) => file.path);
        setSetup({ root: path, files: scan.files, tracked: initial });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!projectId) return;
    let unsubCapture: (() => void) | undefined;
    let unsubProject: (() => void) | undefined;
    let active = true;
    let checking = false;
    const reconcile = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const state = await artlog.projectState(projectId);
        if (!active || projectSnapshotRef.current?.id !== projectId) return;
        setCapture(state.capture);
        const knownHead = projectSnapshotRef.current.commits[0]?.id ?? null;
        if (state.head !== knownHead) {
          const next = await refreshProject(true, false);
          if (!active || projectSnapshotRef.current?.id !== projectId || !next)
            return;
          setCapture(state.capture);
          void loadProjectFiles(projectId);
        }
      } catch (cause) {
        if (active && projectSnapshotRef.current?.id === projectId) {
          setCapture({
            projectId,
            state: "error",
            message: errorMessage(cause),
          });
        }
      } finally {
        checking = false;
      }
    };
    void listen<CaptureStatus>("capture-status", (event) => {
      if (active && event.payload.projectId === projectId)
        setCapture(event.payload);
    })
      .then((unlisten) => {
        if (active) unsubCapture = unlisten;
        else unlisten();
      })
      .catch(() => {
        /* Periodic project-state polling covers unavailable event listeners. */
      });
    void listen<string>("project-updated", (event) => {
      if (!active || event.payload !== projectId) return;
      void reconcile();
    })
      .then((unlisten) => {
        if (active) unsubProject = unlisten;
        else unlisten();
      })
      .catch(() => {
        /* Periodic project-state polling covers unavailable event listeners. */
      });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void reconcile();
    const interval = window.setInterval(() => void reconcile(), 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unsubCapture?.();
      unsubProject?.();
    };
    // Events are best-effort; this small state check is the fallback.
  }, [projectId, refreshProject, loadProjectFiles]);

  const selectedCommitId = selectedCommit?.id;
  useEffect(() => {
    if (!projectId || !selectedCommitId) {
      setSelectedFiles([]);
      setSelectedPath("");
      return;
    }
    let active = true;
    setError("");
    void artlog
      .commitFiles(projectId, selectedCommitId)
      .then((files) => {
        if (!active) return;
        setSelectedFiles(files);
        setSelectedPath((current) =>
          files.some((file) => file.path === current)
            ? current
            : (files[0]?.path ?? ""),
        );
      })
      .catch((cause) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [projectId, selectedCommitId]);

  useEffect(() => {
    if (!restoreTarget) {
      if (dialogRef.current?.open) dialogRef.current.close();
      return;
    }
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, [restoreTarget]);

  useEffect(() => {
    const dialog = checkpointDialogRef.current;
    if (!dialog) return;
    if (checkpointOpen && !dialog.open) dialog.showModal();
    if (!checkpointOpen && dialog.open) dialog.close();
  }, [checkpointOpen]);

  function closeCheckpoint() {
    setCheckpointOpen(false);
    setError("");
  }

  async function makeCheckpoint(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || busy || !checkpointTitle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const next = await artlog.createCheckpoint(
        project.id,
        checkpointTitle.trim(),
        checkpointNote.trim(),
      );
      setProject(next);
      setSettingsDraft(next.settings);
      setSelectedId(next.commits[0]?.id ?? "");
      await loadProjectFiles(next.id);
      setCheckpointTitle("");
      setCheckpointNote("");
      setCheckpointOpen(false);
      setNotice("Checkpoint saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveProjectSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !settingsDraft) return;
    setBusy(true);
    setError("");
    try {
      const next = await artlog.saveSettings(project.id, settingsDraft);
      setProject(next);
      setSettingsDraft(next.settings);
      setCapture(
        next.capture ?? {
          projectId: next.id,
          state: next.settings.autoCapture ? "current" : "paused",
          message: "",
        },
      );
      setNotice("Project settings saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleTracked(path: string) {
    if (!settingsDraft) return;
    setSettingsDraft({
      ...settingsDraft,
      tracked: settingsDraft.tracked.includes(path)
        ? settingsDraft.tracked.filter((item) => item !== path)
        : [...settingsDraft.tracked, path],
    });
  }

  async function restoreAsCopy(commitId: string, file: FileVersion) {
    if (!project) return;
    setError("");
    try {
      const name = fileName(file.path);
      const dot = name.lastIndexOf(".");
      const destination = await save({
        title: "Restore this version as a copy",
        defaultPath: name,
        filters:
          dot > 0
            ? [{ name: "ArtLog file", extensions: [name.slice(dot + 1)] }]
            : undefined,
      });
      if (typeof destination !== "string") return;
      setBusy(true);
      const result = await artlog.restoreCopy(
        project.id,
        commitId,
        file.path,
        destination,
      );
      setNotice(`Restored a verified copy to ${result}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function restoreInPlace() {
    if (!project || !restoreTarget || !restoreConfirmed || busy) return;
    const target = restoreTarget;
    setBusy(true);
    setError("");
    setNotice("");
    setRestoreResult(null);
    try {
      const outcome = await artlog.restoreInPlace(
        project.id,
        target.id,
        target.file.path,
        target.file.path,
      );
      setRestoreResult(outcome);
      setNotice(
        `${fileName(outcome.path)} was restored. A safety snapshot was saved to history.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRestoreTarget(null);
      setRestoreConfirmed(false);
      try {
        const next = await refreshProject();
        if (next) await loadProjectFiles(next.id);
      } catch (cause) {
        setError((current) =>
          current ? `${current}\n${errorMessage(cause)}` : errorMessage(cause),
        );
      }
      setBusy(false);
    }
  }

  async function closeProject() {
    setBusy(true);
    setError("");
    try {
      await artlog.closeProject();
      setProject(null);
      setSetup(null);
      setCapture(null);
      setHealth(null);
      setNotice("");
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const openRestore = (id: string, file: FileVersion) => {
    setError("");
    setRestoreConfirmed(false);
    setRestoreTarget({ id, file });
  };

  const captureState =
    capture?.state ?? (project?.settings.autoCapture ? "current" : "paused");

  const recoverySafetyId = project?.commits.find(
    (commit) => commit.kind === "safety",
  )?.id;

  return (
    <main className="app-shell">
      <aside className={project ? "project-rail" : "rail"} aria-label="ArtLog">
        {project ? (
          <button
            className="brand-mark brand-button"
            aria-label="Close project"
            title="Close project"
            disabled={busy}
            onClick={closeProject}
          >
            <Icon name="brand" />
            <span>ArtLog</span>
          </button>
        ) : (
          <span className="brand-mark">
            <Icon name="brand" />
          </span>
        )}
        {project && (
          <nav className="project-nav" aria-label="Project views">
            {(
              [
                ["history", "History", "history"],
                ["files", "Files", "folder"],
                ["settings", "Settings", "settings"],
              ] as const
            ).map(([destination, label, icon]) => (
              <button
                key={destination}
                className={
                  view === destination ? "nav-button active" : "nav-button"
                }
                aria-current={view === destination ? "page" : undefined}
                onClick={() => setView(destination)}
              >
                <Icon name={icon} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
      </aside>
      <section className="workspace">
        {project && !setup && (
          <header className="topbar">
            <h1 className="project-title" aria-label={project.name}>
              <button
                className="project-picker"
                aria-label={`Open another project. Current project: ${project.name}`}
                title={project.root}
                onClick={chooseProject}
                disabled={busy}
              >
                <Icon name="folder" />
                <span>{project.name}</span>
                <Icon name="chevron" />
              </button>
            </h1>
            <div className="topbar-right">
              <span
                className={`capture-pill state-${captureState}`}
                role="status"
                title={capture?.message || undefined}
              >
                <span className="capture-indicator">
                  <Icon
                    name={
                      captureState === "current"
                        ? "check"
                        : captureState === "paused"
                          ? "pause"
                          : captureState === "error"
                            ? "warning"
                            : "history"
                    }
                  />
                </span>
                {statusName(captureState)}
              </span>
              {view === "history" && (
                <button
                  className="primary-button compact-button"
                  disabled={busy}
                  onClick={() => {
                    setCheckpointOpen(true);
                    setError("");
                  }}
                >
                  New checkpoint
                </button>
              )}
            </div>
          </header>
        )}

        {setup ? (
          <TrackSetup
            setup={setup}
            busy={busy}
            error={error}
            onCancel={() => {
              setSetup(null);
              setError("");
            }}
            onToggle={(path) =>
              setSetup((current) => {
                if (!current) return current;
                return {
                  ...current,
                  tracked: current.tracked.includes(path)
                    ? current.tracked.filter((item) => item !== path)
                    : [...current.tracked, path],
                };
              })
            }
            onSelectAll={(tracked) =>
              setSetup((current) =>
                current ? { ...current, tracked } : current,
              )
            }
            onActivate={() => void activate(setup.root, setup.tracked)}
          />
        ) : !project ? (
          <Welcome busy={busy} error={error} onChooseProject={chooseProject} />
        ) : (
          <div className="project-view-shell">
            {notice && (
              <div className="notice-banner" role="status">
                <span>✓</span>
                {notice}
                <button
                  className="notice-close"
                  aria-label="Dismiss message"
                  onClick={() => {
                    setNotice("");
                    setRestoreResult(null);
                  }}
                >
                  ×
                </button>
              </div>
            )}
            {restoreResult && (
              <div className="safety-notice">
                <div>
                  <strong>Safety snapshot saved.</strong> Version{" "}
                  <code>{restoreResult.safetyId.slice(0, 8)}</code> preserves
                  the work that was in the file before replacement.
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    setView("history");
                    setSelectedId(restoreResult.safetyId);
                  }}
                >
                  View safety snapshot →
                </button>
              </div>
            )}
            {error && !checkpointOpen && (
              <div className="error-message project-error" role="alert">
                {error}
              </div>
            )}
            {project.recoveryPaths.length > 0 && (
              <section
                className="recovery-panel"
                aria-labelledby="recovery-title"
              >
                <Icon name="warning" />
                <div>
                  <h2 id="recovery-title">Recovery files need attention</h2>
                  <p>
                    Keep these files until you verify your work. See the
                    recovery record for the temporary folder and safety
                    checkpoint.
                  </p>
                  {project.recoveryPaths.map((path) => (
                    <code className="recovery-path" key={path}>
                      {joinPath(
                        project.root,
                        ".artlog",
                        "staging",
                        path,
                        "recovery.json",
                      )}
                    </code>
                  ))}
                </div>
                {recoverySafetyId && (
                  <button
                    className="primary-button"
                    onClick={() => {
                      setView("history");
                      setSelectedId(recoverySafetyId);
                    }}
                  >
                    View safety checkpoint
                  </button>
                )}
              </section>
            )}

            {view === "history" && (
              <div className="history-layout">
                <HistoryTimeline
                  commits={project.commits}
                  selectedId={selectedCommit?.id ?? ""}
                  onSelect={setSelectedId}
                />
                <section
                  className="version-panel"
                  aria-label="Selected version details"
                >
                  {selectedCommit ? (
                    <>
                      <VersionDetail
                        commit={selectedCommit}
                        files={selectedFiles}
                        selectedPath={selectedPath}
                        busy={busy}
                        onSelectPath={setSelectedPath}
                        onRestoreCopy={() => {
                          const file = selectedFiles.find(
                            (item) => item.path === selectedPath,
                          );
                          if (file) void restoreAsCopy(selectedCommit.id, file);
                        }}
                        onRestoreInPlace={() => {
                          const file = selectedFiles.find(
                            (item) => item.path === selectedPath,
                          );
                          if (file) openRestore(selectedCommit.id, file);
                        }}
                      />
                      {isClipFile(selectedPath) ? (
                        <PreviewComparison
                          key={`${project.id}:${selectedCommit.id}:${selectedPath}`}
                          projectId={project.id}
                          currentCommit={selectedCommit}
                          commits={project.commits}
                          path={selectedPath}
                        />
                      ) : selectedPath ? (
                        <section
                          className="archived-file"
                          aria-label="Archived file"
                        >
                          <h3>Archived file</h3>
                          <p>
                            Use Restore as a copy to recover this file from an
                            earlier ArtLog project.
                          </p>
                        </section>
                      ) : null}
                    </>
                  ) : (
                    <div className="detail-empty">
                      <Icon name="history" />
                      <p>Saved versions appear here.</p>
                    </div>
                  )}
                  <p className="project-path history-path" title={project.root}>
                    <Icon name="folder" />
                    <span>{project.root}</span>
                  </p>
                </section>
              </div>
            )}

            {view === "files" && (
              <FilesView
                files={workingFiles}
                settings={project.settings}
                onGoSettings={() => setView("settings")}
              />
            )}

            {view === "settings" && settingsDraft && (
              <SettingsView
                project={project}
                settings={settingsDraft}
                health={health}
                healthState={healthState}
                healthError={healthError}
                busy={busy}
                files={workingFiles}
                onChange={setSettingsDraft}
                onToggle={toggleTracked}
                onSave={(event) => void saveProjectSettings(event)}
                onCheckHealth={() => void checkRepositoryHealth(project.id)}
              />
            )}
          </div>
        )}
      </section>

      <dialog
        ref={checkpointDialogRef}
        className="app-dialog"
        aria-labelledby="checkpoint-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) closeCheckpoint();
        }}
      >
        {checkpointOpen && (
          <form
            className="checkpoint-form"
            onSubmit={(event) => void makeCheckpoint(event)}
          >
            <h2 id="checkpoint-title">New checkpoint</h2>
            <label>
              Checkpoint name
              <input
                autoFocus
                maxLength={100}
                value={checkpointTitle}
                onChange={(event) => setCheckpointTitle(event.target.value)}
                required
              />
            </label>
            <label>
              Note <span className="optional-label">(optional)</span>
              <textarea
                maxLength={1000}
                value={checkpointNote}
                onChange={(event) => setCheckpointNote(event.target.value)}
                rows={3}
              />
            </label>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={closeCheckpoint}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy || !checkpointTitle.trim()}
              >
                {busy ? "Saving…" : "Save checkpoint"}
              </button>
            </div>
          </form>
        )}
      </dialog>

      <dialog
        ref={dialogRef}
        className="app-dialog restore-dialog"
        aria-labelledby="restore-title"
        aria-describedby="restore-warning restore-safety"
        onCancel={(event) => {
          event.preventDefault();
          if (busy) return;
          setRestoreTarget(null);
          setRestoreConfirmed(false);
        }}
      >
        {restoreTarget && (
          <>
            <h2 id="restore-title">
              Restore {fileName(restoreTarget.file.path)} in place?
            </h2>
            <p id="restore-warning">
              This replaces the current{" "}
              <strong title={restoreTarget.file.path}>
                {restoreTarget.file.path}
              </strong>{" "}
              with the selected historical version. Close it in Clip Studio
              Paint first so the editor does not save over the restored file.
            </p>
            <p id="restore-safety">
              ArtLog saves a safety snapshot of the current work before
              replacement.
            </p>
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={restoreConfirmed}
                disabled={busy}
                onChange={(event) => setRestoreConfirmed(event.target.checked)}
              />
              <span>
                I understand this replaces{" "}
                <strong>{restoreTarget.file.path}</strong>
              </span>
            </label>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                autoFocus
                disabled={busy}
                onClick={() => {
                  setRestoreTarget(null);
                  setRestoreConfirmed(false);
                }}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                disabled={!restoreConfirmed || busy}
                onClick={() => void restoreInPlace()}
              >
                {busy ? "Restoring safely…" : "Replace with this version"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </main>
  );
}

function FilesView({
  files,
  settings,
  onGoSettings,
}: {
  files: ScanEntry[];
  settings: Settings;
  onGoSettings: () => void;
}) {
  const tracked = new Set(settings.tracked);
  return (
    <section className="standalone-panel files-view">
      <div className="eyebrow">PROJECT CONTENTS</div>
      <h2>Tracked files</h2>
      <p className="section-description">
        ArtLog watches Clip Studio Paint .clip files while you work.
      </p>
      {files.length === 0 ? (
        <div className="empty-card compact-empty">
          <div className="empty-icon">▤</div>
          <h2>No files found</h2>
          <p>
            Add artwork to the project folder, then update which files ArtLog
            tracks.
          </p>
          <button className="secondary-button" onClick={onGoSettings}>
            Manage tracked files
          </button>
        </div>
      ) : (
        <div className="tracked-list">
          {files.map((file) => (
            <div className="tracked-row" key={file.path}>
              <span className="file-glyph artwork">
                {fileName(file.path)
                  .split(".")
                  .at(-1)
                  ?.slice(0, 4)
                  .toUpperCase() ?? "FILE"}
              </span>
              <span className="tracked-name" title={file.path}>
                {file.path}
              </span>
              <span className="scan-badge">CLIP STUDIO PAINT</span>
              <span
                className={
                  tracked.has(file.path) ? "tracking-on" : "tracking-off"
                }
              >
                {tracked.has(file.path) ? "TRACKED" : "NOT TRACKED"}
              </span>
              <span className="scan-size">{formatBytes(file.size)}</span>
            </div>
          ))}
        </div>
      )}
      <button className="secondary-button" onClick={onGoSettings}>
        Manage tracked files
      </button>
    </section>
  );
}

function SettingsView({
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
    <form className="standalone-panel settings-view" onSubmit={onSave}>
      <div className="eyebrow">PROJECT PREFERENCES</div>
      <h2>Settings</h2>
      <p className="section-description">
        Choose what ArtLog preserves and when it records your saved files.
      </p>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <h3>Automatic capture</h3>
            <p>
              Wait for saves to settle, then record changed artwork without
              duplicate versions.
            </p>
          </div>
          <label className="switch-control" aria-label="Automatic capture">
            <input
              type="checkbox"
              checked={settings.autoCapture}
              onChange={(event) =>
                onChange({ ...settings, autoCapture: event.target.checked })
              }
            />
            <span />
          </label>
        </div>
        <label className="setting-range">
          <span>
            <strong>Save stability delay</strong>
            <small>
              ArtLog checks that file size and modification time stop changing.
            </small>
          </span>
          <span className="range-value">
            {(settings.debounceMs / 1000).toFixed(2)}s
          </span>
          <input
            type="range"
            min={250}
            max={10000}
            step={250}
            value={settings.debounceMs}
            onChange={(event) =>
              onChange({ ...settings, debounceMs: Number(event.target.value) })
            }
          />
          <span className="range-ends">
            <span>250 ms</span>
            <span>10 seconds</span>
          </span>
        </label>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <h3>Files in history</h3>
            <p>Select the .clip files ArtLog should preserve.</p>
          </div>
          <span className="version-count">
            {settings.tracked.length} TRACKED
          </span>
        </div>
        <div className="scan-list settings-scan">
          {files.length ? (
            files.map((file) => (
              <label className="scan-row" key={file.path}>
                <input
                  aria-label={file.path}
                  type="checkbox"
                  checked={tracked.has(file.path)}
                  onChange={() => onToggle(file.path)}
                />
                <span className="file-glyph artwork">
                  {fileName(file.path)
                    .split(".")
                    .at(-1)
                    ?.slice(0, 4)
                    .toUpperCase() ?? "FILE"}
                </span>
                <span className="scan-name" title={file.path}>
                  {file.path}
                </span>
                <span className="scan-badge">CLIP</span>
                <span className="scan-size">{formatBytes(file.size)}</span>
              </label>
            ))
          ) : (
            <div className="empty-inline">
              No files are currently available in the project folder.
            </div>
          )}
        </div>
      </section>
      <section className="settings-section repository-stats">
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
        <div className="stat-cards">
          <div className="stat-card">
            <span>PORTABLE HISTORY</span>
            <strong>{formatBytes(project.size)}</strong>
            <small>Stored in this project folder</small>
          </div>
          <div className="stat-card">
            <span>VERSIONS</span>
            <strong>{health?.versions ?? project.commits.length}</strong>
            <small>On the main history line</small>
          </div>
          <div className="stat-card">
            <span>CONTENT OBJECTS</span>
            <strong>
              {health
                ? health.objects
                : healthState === "loading"
                  ? "…"
                  : "Not checked"}
            </strong>
            <small>Local objects in the repository</small>
          </div>
        </div>
      </section>
      <div className="settings-footer">
        <span>{unchanged ? "No unsaved changes" : "Unsaved settings"}</span>
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
