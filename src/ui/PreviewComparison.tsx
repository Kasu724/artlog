import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { artlog } from "../api";
import type { CommitSummary, Preview } from "../types";
import { errorMessage, formatDate, isClipFile } from "./format";
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

export function PreviewComparison({
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
  const showsCombinedPreview =
    (mode === "overlay" && sameDimensions) ||
    (mode === "difference" && difference);
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
        <h3>Compare versions</h3>
        <button
          className="text-button"
          disabled={!path}
          aria-expanded={pickerOpen}
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
      {showsCombinedPreview && (
        <div className="compare-version-labels">
          <span title={comparisonCommit?.title}>
            Earlier version
            {comparisonCommit ? ` · ${comparisonCommit.title}` : ""}
          </span>
          <span title={currentCommit.title}>
            Selected version · {currentCommit.title}
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
              alt={`Earlier version of ${path}`}
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
            label="Earlier version"
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
            label="Selected version"
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
          {current.result.state === "ready" &&
            comparison.result.state === "ready" && (
              <div
                className="compare-modes"
                role="group"
                aria-label="Comparison mode"
              >
                <button
                  aria-pressed={mode === "side"}
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
            )}
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
          Zoom with + and − or Ctrl/⌘ + scroll. Pan with arrow keys or drag.
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
      <span className="preview-card-label" title={commit?.title}>
        {label}
        {commit && <small>{commit.title}</small>}
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
          <Icon name="file" />
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
      {commit && isClipFile(path) && (
        <button
          className="secondary-button attach-preview"
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
