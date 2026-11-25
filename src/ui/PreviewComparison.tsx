import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artlog } from "../api";
import type { CommitSummary, ComparisonVersion, Preview } from "../types";
import { errorMessage, formatDate } from "./format";
import { Icon } from "./Icon";
import { createPixelDifference } from "./pixel-difference";
import "./preview-comparison.css";

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
  return { result, retry: () => setRetry((value) => value + 1) };
}

export function PreviewComparison({
  projectId,
  currentCommit,
  commits,
  path,
  fileId,
  onTimelinePickerChange,
  timelinePick,
}: {
  projectId: string;
  currentCommit: CommitSummary;
  commits: CommitSummary[];
  path: string;
  fileId?: string | null;
  onTimelinePickerChange: (eligibleIds: string[] | null) => void;
  timelinePick: { id: string } | null;
}) {
  const current = usePreview(projectId, currentCommit.id, path);
  const [selection, setSelection] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const compareId = selection?.id ?? "";
  const [pickerArmed, setPickerArmed] = useState(false);
  const [versionPaths, setVersionPaths] = useState<ComparisonVersion[]>([]);
  const [candidateState, setCandidateState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const candidates = useMemo(() => {
    const pathsById = new Map(versionPaths.map(({ id, path }) => [id, path]));
    return commits.flatMap((commit) => {
      const path = pathsById.get(commit.id);
      return path && commit.id !== currentCommit.id
        ? [{ ...commit, path }]
        : [];
    });
  }, [commits, currentCommit.id, versionPaths]);
  const [candidateError, setCandidateError] = useState("");
  const [candidateRetry, setCandidateRetry] = useState(0);
  const comparisonCommit = commits.find((commit) => commit.id === compareId);
  const comparison = usePreview(
    projectId,
    comparisonCommit?.id ?? "",
    selection?.path ?? "",
  );
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
  const disarmPicker = useCallback(() => {
    setPickerArmed(false);
    onTimelinePickerChange(null);
  }, [onTimelinePickerChange]);

  const chooseVersion = useCallback(
    (candidate: { id: string; path: string } | null) => {
      setSelection(candidate);
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setMode("side");
      setDifference(null);
      setDifferenceState("idle");
      disarmPicker();
    },
    [disarmPicker],
  );

  const sameDimensions =
    current.result.state === "ready" &&
    comparison.result.state === "ready" &&
    current.result.preview.width === comparison.result.preview.width &&
    current.result.preview.height === comparison.result.preview.height;
  const showsCombinedPreview =
    (mode === "overlay" && sameDimensions) ||
    (mode === "difference" && difference);
  const anyPreview =
    current.result.state === "ready" || comparison.result.state === "ready";

  const historyHead = commits[0]?.id;
  useEffect(() => {
    let active = true;
    setCandidateState("loading");
    setCandidateError("");
    void artlog
      .comparisonVersions(projectId, path, fileId)
      .then((versions) => {
        if (!active) return;
        setVersionPaths(versions);
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
  }, [projectId, path, fileId, historyHead, candidateRetry]);

  useEffect(() => {
    if (!pickerArmed) return;
    onTimelinePickerChange(candidates.map(({ id }) => id));
  }, [pickerArmed, candidates, onTimelinePickerChange]);

  useEffect(() => {
    if (!pickerArmed) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest("dialog[open]"))
      )
        return;
      event.preventDefault();
      chooseVersion(null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [pickerArmed, chooseVersion]);

  useEffect(() => () => onTimelinePickerChange(null), [onTimelinePickerChange]);

  useEffect(() => {
    if (!timelinePick) return;
    const candidate = candidates.find(({ id }) => id === timelinePick.id);
    if (candidate) chooseVersion(candidate);
  }, [timelinePick, candidates, chooseVersion]);

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

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }
  function zoomBy(amount: number) {
    setZoom((value) =>
      Math.max(1, Math.min(5, Number((value + amount).toFixed(2)))),
    );
  }
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
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
  const canCompare = candidates.length > 0;

  function toggleTimelinePicker() {
    if (pickerArmed) disarmPicker();
    else if (canCompare) setPickerArmed(true);
  }

  return (
    <section className="compare-panel" aria-label="Preview comparison">
      <div className="compare-picker">
        <label>
          Previous version
          <select
            aria-label="Compare with version"
            value={compareId}
            disabled={!canCompare}
            onChange={(event) => {
              const candidate = candidates.find(
                ({ id }) => id === event.target.value,
              );
              chooseVersion(candidate ?? null);
            }}
          >
            <option value="">
              {canCompare
                ? "Choose a version"
                : candidateState === "loading"
                  ? "Finding versions…"
                  : candidateState === "error"
                    ? "Versions unavailable"
                    : "No other versions"}
            </option>
            {candidates.map((commit) => (
              <option key={commit.id} value={commit.id}>
                {commit.title} · {formatDate(commit.timestamp).day}
              </option>
            ))}
          </select>
        </label>
        {candidateState === "error" && (
          <div className="compare-error" role="alert">
            {candidateError}
            <button
              className="text-button"
              onClick={() => setCandidateRetry((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        )}
      </div>
      <div className="preview-controls-row">
        <div
          className="compare-modes"
          role="group"
          aria-label="Comparison mode"
        >
          <button
            aria-pressed={mode === "side"}
            disabled={!comparisonCommit}
            onClick={() => setMode("side")}
          >
            Side by side
          </button>
          <button
            aria-pressed={mode === "overlay"}
            disabled={!sameDimensions}
            onClick={() => setMode("overlay")}
          >
            Overlay
          </button>
          <button
            aria-pressed={mode === "difference"}
            disabled={!sameDimensions}
            onClick={() => setMode("difference")}
          >
            Difference
          </button>
        </div>
        <div
          className="preview-pan-controls"
          role="group"
          aria-label="Synchronized zoom and pan controls"
        >
          <button
            aria-label="Zoom out"
            onClick={() => zoomBy(-0.15)}
            disabled={!anyPreview || zoom <= 1}
          >
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="Zoom in"
            onClick={() => zoomBy(0.15)}
            disabled={!anyPreview || zoom >= 5}
          >
            ＋
          </button>
          <button
            aria-label="Reset zoom and pan"
            disabled={!anyPreview}
            onClick={resetView}
          >
            Reset
          </button>
        </div>
      </div>
      {mode === "overlay" && sameDimensions && (
        <label className="opacity-control">
          Current version opacity{" "}
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
      {showsCombinedPreview && (
        <div className="compare-version-labels">
          <span title={comparisonCommit?.title}>
            Previous version
            {comparisonCommit ? ` · ${comparisonCommit.title}` : ""}
          </span>
          <span title={currentCommit.title}>
            Current version · {currentCommit.title}
          </span>
        </div>
      )}
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
              draggable={false}
              src={comparison.result.preview.dataUrl}
              alt={`Previous version of ${selection?.path ?? path}`}
            />
            <img
              draggable={false}
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
            draggable={false}
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
            label="Previous version"
            path={selection?.path ?? path}
            commit={comparisonCommit}
            state={comparison.result}
            loading={comparison.result.state === "loading"}
            onRetry={comparison.retry}
            zoom={zoom}
            pan={pan}
            onKeyDown={onKeyDown}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onWheel={wheel}
            pickerArmed={pickerArmed}
            onPick={canCompare ? toggleTimelinePicker : undefined}
          />
          <PreviewPane
            label="Current version"
            path={path}
            commit={currentCommit}
            state={current.result}
            loading={current.result.state === "loading"}
            onRetry={current.retry}
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
          Zoom with +/− or Ctrl/⌘ + scroll. Pan with arrow keys or drag.
        </p>
      )}
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
  zoom,
  pan,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  pickerArmed,
  onPick,
}: {
  label: string;
  path: string;
  commit: CommitSummary | undefined;
  state: PreviewLoad;
  loading: boolean;
  onRetry: () => void;
  zoom: number;
  pan: { x: number; y: number };
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  pickerArmed?: boolean;
  onPick?: () => void;
}) {
  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(
    null,
  );
  const pickerRef = useRef<HTMLButtonElement>(null);
  const adapterNote =
    state.state === "ready"
      ? state.preview.adapter === "clip"
        ? `Clip Studio Paint preview · ${state.preview.width} × ${state.preview.height}`
        : `Attached export · approximate · ${state.preview.width} × ${state.preview.height}`
      : "";
  return (
    <div className="preview-pane">
      <div
        className={`preview-frame${onPick ? " comparison-target" : ""}${pickerArmed ? " timeline-picker-armed" : ""}`}
        onPointerDownCapture={(event) => {
          if (onPick)
            pointer.current = {
              x: event.clientX,
              y: event.clientY,
              dragged: false,
            };
        }}
        onPointerMoveCapture={(event) => {
          const start = pointer.current;
          if (
            start &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
          ) {
            start.dragged = true;
          }
        }}
        onClick={(event) => {
          if (
            !onPick ||
            pointer.current?.dragged ||
            (event.target instanceof Element && event.target.closest("button"))
          )
            return;
          pickerRef.current?.focus({ preventScroll: true });
          onPick();
        }}
      >
        {pickerArmed && (
          <p className="timeline-picker-hint" role="status">
            Choose a version in history
          </p>
        )}
        {!commit ? (
          <div className="preview-state">
            {onPick ? <Icon name="history" /> : "No previous version selected"}
          </div>
        ) : loading ? (
          <div className="preview-state" role="status">
            Loading preview…
          </div>
        ) : state.state === "ready" ? (
          <div
            className="preview-thumb-stage"
            tabIndex={onPick ? undefined : 0}
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
            <Icon name="file" />
            <span>No preview saved for this version</span>
          </div>
        )}
        {onPick && (
          <button
            ref={pickerRef}
            className="preview-frame-picker"
            type="button"
            aria-label="Choose previous version from timeline"
            aria-pressed={!!pickerArmed}
            onClick={onPick}
            onKeyDown={state.state === "ready" ? onKeyDown : undefined}
          />
        )}
      </div>
      <span className="preview-card-label" title={commit?.title}>
        {label}
        {commit && <small>{commit.title}</small>}
      </span>
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
    </div>
  );
}
