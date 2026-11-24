import { invoke } from "@tauri-apps/api/core";
import type {
  CommitThumbnail,
  ComparisonVersion,
  FileVersion,
  HistoryRepack,
  Preview,
  ProjectView,
  ProjectState,
  RepositoryHealth,
  RepackMode,
  RestoreOutcome,
  Settings,
} from "./types";

export const artlog = {
  openClip: (path: string) => invoke<ProjectView>("open_clip", { path }),
  openContainerProject: (root: string, id: string) =>
    invoke<ProjectView>("open_container_project", { root, id }),
  closeProject: () => invoke<void>("close_project"),
  projectView: (projectId: string) =>
    invoke<ProjectView>("project_view", { projectId }),
  projectState: (projectId: string) =>
    invoke<ProjectState>("project_state", { projectId }),
  commitFiles: (projectId: string, id: string) =>
    invoke<FileVersion[]>("list_commit_files", { projectId, id }),
  comparisonVersions: (
    projectId: string,
    path: string,
    fileId?: string | null,
  ) =>
    invoke<ComparisonVersion[]>("comparison_versions", {
      projectId,
      path,
      fileId,
    }),
  updateVersionDetails: (
    projectId: string,
    id: string,
    title: string,
    note: string,
  ) =>
    invoke<ProjectView>("update_version_details", {
      projectId,
      id,
      title,
      note,
    }),
  saveSettings: (projectId: string, settings: Settings) =>
    invoke<ProjectView>("save_settings", { projectId, settings }),
  setHistoryCompression: (projectId: string, enabled: boolean) =>
    invoke<number>("set_history_compression", { projectId, enabled }),
  repackHistory: (projectId: string, mode: RepackMode) =>
    invoke<HistoryRepack>("repack_history", { projectId, mode }),
  restoreCopy: (
    projectId: string,
    id: string,
    path: string,
    destination: string,
  ) => invoke<string>("restore_copy", { projectId, id, path, destination }),
  restoreInPlace: (
    projectId: string,
    id: string,
    path: string,
    confirmedTarget: string,
  ) =>
    invoke<RestoreOutcome>("restore_in_place", {
      projectId,
      id,
      path,
      confirmedTarget,
    }),
  repositoryHealth: (projectId: string) =>
    invoke<RepositoryHealth>("repository_health", { projectId }),
  getPreview: (projectId: string, id: string, path: string) =>
    invoke<Preview | null>("get_preview", { projectId, id, path }),
  getCommitThumbnail: (projectId: string, id: string, path?: string) =>
    invoke<CommitThumbnail | null>(
      "get_commit_thumbnail",
      path ? { projectId, id, path } : { projectId, id },
    ),
  relinkFile: (projectId: string, fileId: string, destination: string) =>
    invoke<ProjectView>("relink_file", { projectId, fileId, destination }),
  renameProject: (projectId: string, name: string) =>
    invoke<ProjectView>("rename_project", { projectId, name }),
  deleteHistory: (projectId: string, confirmation: string) =>
    invoke<void>("delete_history", { projectId, confirmation }),
};
