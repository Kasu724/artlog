import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { artlog } from "../api";
import type {
  CaptureStatus,
  CommitSummary,
  FileVersion,
  ProjectFile,
  ProjectView,
  RepackMode,
  RepositoryHealth,
  RestoreOutcome,
  Settings,
  ViewName,
} from "../types";
import { Icon } from "./Icon";
import { ProjectOptions, SettingsView } from "./ProjectSettings";
import { HistoryTimeline, VersionDetail } from "./History";
import { PreviewComparison } from "./PreviewComparison";
import { RecentProjects, Welcome } from "./ProjectEntry";
import {
  readRecentProjects,
  rememberRecentProject,
  writeRecentProjects,
} from "./recent-projects";
import { DeleteHistoryDialog } from "./ProjectManagement";
import { errorMessage, fileName } from "./format";

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
  const [recentProjects, setRecentProjects] = useState(readRecentProjects);
  const [timelinePicker, setTimelinePicker] = useState<{
    scope: string;
    eligibleIds: string[];
    pick: { id: string } | null;
  } | null>(null);
  const [view, setView] = useState<ViewName>("history");
  const [selectedId, setSelectedId] = useState("");
  const [versionFile, setVersionFile] = useState<{
    projectId: string;
    versionId: string;
    file: FileVersion | null;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
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
  const [editingVersion, setEditingVersion] = useState<{
    id: string;
    title: string;
    note: string;
  } | null>(null);
  const [editError, setEditError] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<{
    id: string;
    file: FileVersion;
  } | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreOutcome | null>(
    null,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);
  const projectSnapshotRef = useRef<ProjectView | null>(null);
  projectSnapshotRef.current = project;

  const timelineCommits = project?.commits ?? [];
  const selectedCommit =
    timelineCommits.find((commit) => commit.id === selectedId) ??
    timelineCommits[0] ??
    null;
  const workingPath = project?.project.path ?? "";
  const workingFile = project?.files.find((file) => file.path === workingPath);
  const workingFileId = workingFile?.id;
  const selectedCommitId = selectedCommit?.id;
  const selectedVersionReady =
    versionFile?.projectId === project?.id &&
    versionFile?.versionId === selectedCommitId &&
    versionFile !== null;
  const selectedFile = selectedVersionReady ? versionFile.file : null;

  useEffect(() => {
    writeRecentProjects(recentProjects);
  }, [recentProjects]);

  const projectId = project?.id;
  const refreshProject = useCallback(
    async (keepSelection = true, syncSettings = true) => {
      if (!projectId) return null;
      const next = await artlog.projectView(projectId);
      if (projectSnapshotRef.current?.id !== projectId) return null;
      if (projectSnapshotRef.current.name !== next.name) {
        setRecentProjects((items) => rememberRecentProject(items, next));
      }
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

  async function checkRepositoryHealth(id: string) {
    setHealthState("loading");
    setHealthError("");
    try {
      const result = await artlog.repositoryHealth(id);
      if (projectSnapshotRef.current?.id !== id) return;
      setHealth(result);
      setHealthState("idle");
    } catch (cause) {
      if (projectSnapshotRef.current?.id !== id) return;
      setHealth(null);
      setHealthError(errorMessage(cause));
      setHealthState("error");
    }
  }

  function installProject(next: ProjectView) {
    setRecentProjects((items) => rememberRecentProject(items, next));
    setTimelinePicker(null);
    projectSnapshotRef.current = next;
    setProject(next);
    setSettingsDraft(next.settings);
    setSelectedId(next.commits[0]?.id ?? "");
    setVersionFile(null);
    setView("history");
    setCapture(next.capture ?? null);
    setHealth(null);
    setHealthState("idle");
    setHealthError("");
    setRestoreResult(null);
    setNotice("");
  }

  async function activate(operation: () => Promise<ProjectView>) {
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      installProject(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const openInContainer = (root: string, id: string) =>
    activate(() => artlog.openContainerProject(root, id));

  async function chooseClip() {
    setError("");
    try {
      const absolute = await open({
        multiple: false,
        title: "Choose a Clip Studio Paint file",
        filters: [{ name: "Clip Studio Paint", extensions: ["clip"] }],
      });
      if (typeof absolute !== "string") return;
      setBusy(true);
      await activate(() => artlog.openClip(absolute));
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
        const currentProject = projectSnapshotRef.current;
        const knownHead = currentProject.commits[0]?.id ?? null;
        const previousPath = currentProject.project.path;
        const renamedPath =
          state.path != null &&
          previousPath != null &&
          state.path !== previousPath;
        if (state.head !== knownHead || renamedPath) {
          const next = await refreshProject(true, false);
          if (!active || projectSnapshotRef.current?.id !== projectId || !next)
            return;
          const newPath = next.project.path;
          if (
            previousPath != null &&
            newPath != null &&
            newPath !== previousPath
          ) {
            setSettingsDraft((draft) =>
              draft
                ? {
                    ...draft,
                    tracked: draft.tracked.map((path) =>
                      path === previousPath ? newPath : path,
                    ),
                  }
                : draft,
            );
          }
          setCapture(state.capture);
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
  }, [projectId, refreshProject]);

  useEffect(() => {
    if (!projectId || !selectedCommitId) return;
    let active = true;
    void artlog
      .commitFiles(projectId, selectedCommitId)
      .then((files) => {
        if (!active) return;
        const file =
          files.find(
            (item) => workingFileId && item.fileId === workingFileId,
          ) ??
          files.find(
            (item) =>
              item.path === workingPath && (!workingFileId || !item.fileId),
          ) ??
          null;
        setVersionFile({ projectId, versionId: selectedCommitId, file });
      })
      .catch((cause) => {
        if (active) {
          setVersionFile({
            projectId,
            versionId: selectedCommitId,
            file: null,
          });
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [projectId, selectedCommitId, workingFileId, workingPath]);

  useEffect(() => {
    if (!restoreTarget) {
      if (dialogRef.current?.open) dialogRef.current.close();
      return;
    }
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, [restoreTarget]);

  const editing = editingVersion !== null;
  useEffect(() => {
    const dialog = editDialogRef.current;
    if (!dialog) return;
    if (editing && !dialog.open) dialog.showModal();
    if (!editing && dialog.open) dialog.close();
  }, [editing]);

  function editVersion(commit: CommitSummary) {
    setEditError("");
    setEditingVersion({
      id: commit.id,
      title: commit.title,
      note: commit.note,
    });
  }

  async function saveVersionDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !editingVersion || busy || !editingVersion.title.trim())
      return;
    setBusy(true);
    setEditError("");
    try {
      const { id, title, note } = editingVersion;
      const next = await artlog.updateVersionDetails(
        project.id,
        id,
        title,
        note,
      );
      setProject(next);
      setEditingVersion(null);
    } catch (cause) {
      setEditError(errorMessage(cause));
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

  async function changeHistoryStorage(
    progress: string,
    change: () => Promise<{ size: number; enabled?: boolean; message: string }>,
  ) {
    if (!project || busy) return;
    setBusy(true);
    setError("");
    setNotice(progress);
    try {
      const { size, enabled, message } = await change();
      setProject((current) =>
        current?.id === project.id
          ? {
              ...current,
              size,
              historyCompression: enabled ?? current.historyCompression,
            }
          : current,
      );
      setNotice(message);
    } catch (cause) {
      // A stopped raw conversion may already have disabled compression or expanded objects.
      await refreshProject(true, false).catch(() => undefined);
      setNotice("");
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleHistoryCompression(id: string, enabled: boolean) {
    return changeHistoryStorage(
      "Saving history compression setting…",
      async () => ({
        size: await artlog.setHistoryCompression(id, enabled),
        enabled,
        message: enabled
          ? "History compression is on."
          : "History compression is off.",
      }),
    );
  }

  function repackHistory(id: string, mode: RepackMode) {
    const progress =
      mode === "raw"
        ? "Converting history to raw…"
        : "Compressing existing history…";
    return changeHistoryStorage(progress, async () => {
      const { report, size } = await artlog.repackHistory(id, mode);
      if (mode === "raw") {
        const bytes = report.afterBytes.toLocaleString();
        return {
          size,
          enabled: false,
          message: `Raw layout verified. Compression is off. Content objects use ${bytes} bytes.`,
        };
      }
      const saved = (report.beforeBytes - report.afterBytes).toLocaleString();
      return {
        size,
        message: report.objectsRewritten
          ? `History compressed. Saved ${saved} bytes in content objects.`
          : "History verified. No additional objects met the savings threshold.",
      };
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
        await refreshProject();
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
      projectSnapshotRef.current = null;
      setProject(null);
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

  async function updateProject(
    operation: () => Promise<ProjectView>,
    message: string,
  ) {
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      setRecentProjects((items) => rememberRecentProject(items, next));
      projectSnapshotRef.current = next;
      setProject(next);
      setSettingsDraft(next.settings);
      setCapture(next.capture ?? null);
      setNotice(message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function relink(file: ProjectFile) {
    if (!project) return;
    try {
      const path = await open({
        multiple: false,
        defaultPath: project.root,
        title: `Choose the new location of ${fileName(file.path)}`,
        filters: [{ name: "Clip Studio Paint", extensions: ["clip"] }],
      });
      if (typeof path !== "string") return;
      await updateProject(
        () => artlog.relinkFile(project.id, file.id, path),
        "Working file linked to its saved history.",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function deleteHistory(typed: string) {
    if (!project || !confirmDelete || busy) return;
    setBusy(true);
    setDeleteError("");
    try {
      await artlog.deleteHistory(project.id, typed);
      setRecentProjects((items) =>
        items.filter(
          (item) =>
            item.root !== project.root || item.id !== project.project.id,
        ),
      );
      projectSnapshotRef.current = null;
      setProject(null);
      setCapture(null);
      setError("");
      setNotice(`Deleted history for ${workingPath}.`);
      setConfirmDelete(false);
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const comparisonScope =
    project && view === "history" && selectedCommit && selectedFile
      ? JSON.stringify([project.id, selectedCommit.id, selectedFile.path])
      : null;
  const activePicker =
    timelinePicker?.scope === comparisonScope ? timelinePicker : null;
  const updateTimelinePicker = useCallback(
    (eligibleIds: string[] | null) => {
      if (!comparisonScope) return;
      setTimelinePicker((current) => {
        if (!eligibleIds) {
          return current?.scope === comparisonScope ? null : current;
        }
        return {
          scope: comparisonScope,
          eligibleIds,
          pick: current?.scope === comparisonScope ? current.pick : null,
        };
      });
    },
    [comparisonScope],
  );

  function selectTimelineEntry(id: string) {
    if (!activePicker) {
      setError("");
      setSelectedId(id);
    } else if (activePicker.eligibleIds.includes(id)) {
      setTimelinePicker({ ...activePicker, pick: { id } });
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
    <main className={`app-shell${!project ? " home-shell" : ""}`}>
      {project && (
        <header className="topbar project-topbar">
          <button
            type="button"
            className="brand-mark quiet-button home-button"
            aria-label="ArtLog home"
            disabled={busy}
            onClick={() => void closeProject()}
          >
            <Icon name="brand" />
            ArtLog
          </button>
          <h1
            className="project-title"
            title={joinPath(project.root, workingPath)}
          >
            <bdi>{workingPath}</bdi>
          </h1>
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
        </header>
      )}

      {project ? (
        <aside className="project-rail">
          <nav className="project-nav" aria-label="Project views">
            {(
              [
                ["history", "History", "history"],
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
        </aside>
      ) : (
        <aside className="home-rail">
          <RecentProjects
            projects={recentProjects}
            busy={busy}
            onOpen={(item) => void openInContainer(item.root, item.id)}
          />
        </aside>
      )}

      <section className="workspace">
        {!project ? (
          <Welcome
            busy={busy}
            error={error}
            notice={notice}
            onChooseClip={chooseClip}
          />
        ) : (
          <div
            className={`project-view-shell${view === "history" ? " history-workspace" : ""}`}
          >
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
            {error && (
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
                    snapshot.
                  </p>
                  {project.recoveryPaths.map((path) => (
                    <code className="recovery-path" key={path}>
                      {joinPath(
                        project.metadata,
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
                    View safety snapshot
                  </button>
                )}
              </section>
            )}

            {view === "history" && (
              <>
                <h2 className="page-heading">History</h2>
                <div className="history-layout">
                  <HistoryTimeline
                    projectId={project.id}
                    commits={timelineCommits}
                    selectedId={selectedCommit?.id ?? ""}
                    comparisonCandidates={activePicker?.eligibleIds ?? null}
                    onSelect={selectTimelineEntry}
                    onEdit={editVersion}
                    editDisabled={busy}
                  />
                  <section
                    className="version-panel"
                    aria-label="Selected version details"
                  >
                    {selectedCommit ? (
                      <VersionDetail
                        commit={selectedCommit}
                        file={selectedFile}
                        loading={!selectedVersionReady}
                        busy={busy}
                        canReplace={
                          project.recoveryPaths.length === 0 &&
                          !!workingFile?.present &&
                          workingFile.tracked &&
                          selectedFile?.path === workingPath &&
                          (!selectedFile?.fileId ||
                            selectedFile.fileId === workingFileId)
                        }
                        onRestoreCopy={() => {
                          if (selectedFile)
                            void restoreAsCopy(selectedCommit.id, selectedFile);
                        }}
                        onRestoreInPlace={() => {
                          if (selectedFile)
                            openRestore(selectedCommit.id, selectedFile);
                        }}
                      >
                        {selectedFile && (
                          <PreviewComparison
                            key={comparisonScope}
                            projectId={project.id}
                            currentCommit={selectedCommit}
                            commits={project.commits}
                            path={selectedFile.path}
                            fileId={selectedFile.fileId}
                            onTimelinePickerChange={updateTimelinePicker}
                            timelinePick={activePicker?.pick ?? null}
                          />
                        )}
                      </VersionDetail>
                    ) : (
                      <div className="detail-empty">
                        <Icon name="history" />
                        <p>Saved versions appear here.</p>
                      </div>
                    )}
                    <p
                      className="project-path history-path"
                      title={project.root}
                    >
                      <Icon name="folder" />
                      <span>{project.root}</span>
                    </p>
                  </section>
                </div>
              </>
            )}

            {view === "settings" && settingsDraft && (
              <>
                <SettingsView
                  project={project}
                  settings={settingsDraft}
                  health={health}
                  healthState={healthState}
                  healthError={healthError}
                  busy={busy}
                  onChange={setSettingsDraft}
                  onSave={(event) => void saveProjectSettings(event)}
                  onCheckHealth={() => void checkRepositoryHealth(project.id)}
                  onCompression={(enabled) =>
                    void toggleHistoryCompression(project.id, enabled)
                  }
                  onRepack={(mode) => void repackHistory(project.id, mode)}
                />
                <ProjectOptions
                  key={`${project.id}:${project.name}`}
                  project={project}
                  busy={busy}
                  onRename={(name) =>
                    void updateProject(
                      () => artlog.renameProject(project.id, name),
                      "Project renamed.",
                    )
                  }
                  workingFile={workingFile}
                  onRelink={(file) => void relink(file)}
                  onDelete={() => {
                    setDeleteError("");
                    setConfirmDelete(true);
                  }}
                />
              </>
            )}
          </div>
        )}
      </section>
      <DeleteHistoryDialog
        filename={confirmDelete ? workingPath : ""}
        location={project?.root ?? ""}
        busy={busy}
        error={deleteError}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={(typed) => void deleteHistory(typed)}
      />

      <dialog
        ref={editDialogRef}
        className="app-dialog"
        aria-labelledby="edit-version-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) setEditingVersion(null);
        }}
      >
        {editingVersion && (
          <form
            className="version-edit-form"
            onSubmit={(event) => void saveVersionDetails(event)}
          >
            <h2 id="edit-version-title">Edit version details</h2>
            <label>
              Version title
              <input
                autoFocus
                maxLength={100}
                value={editingVersion.title}
                disabled={busy}
                onChange={(event) =>
                  setEditingVersion({
                    ...editingVersion,
                    title: event.target.value,
                  })
                }
                required
              />
            </label>
            <label>
              Notes <span className="optional-label">(optional)</span>
              <textarea
                maxLength={1000}
                value={editingVersion.note}
                disabled={busy}
                onChange={(event) =>
                  setEditingVersion({
                    ...editingVersion,
                    note: event.target.value,
                  })
                }
                rows={3}
              />
            </label>
            {editError && (
              <p className="error-message" role="alert">
                {editError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => setEditingVersion(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy || !editingVersion.title.trim()}
              >
                {busy ? "Saving…" : "Save details"}
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
