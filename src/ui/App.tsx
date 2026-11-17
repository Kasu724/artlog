import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { artlog } from "../api";
import type {
  CaptureStatus,
  FileVersion,
  ProjectView,
  RepositoryHealth,
  RestoreOutcome,
  ScanEntry,
  Settings,
  ViewName,
} from "../types";
import { Icon } from "./Icon";
import { FilesView, SettingsView } from "./ProjectSettings";
import { HistoryTimeline, VersionDetail } from "./History";
import { PreviewComparison } from "./PreviewComparison";
import { TrackSetup, Welcome, type Setup } from "./ProjectEntry";
import { errorMessage, fileName, isClipFile } from "./format";

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
                root={project.root}
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
