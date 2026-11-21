import { invoke } from "@tauri-apps/api/core";
import type {
  CommitThumbnail,
  ComparisonVersion,
  FileVersion,
  Preview,
  ProjectView,
  ProjectState,
  RepositoryHealth,
  RestoreOutcome,
  ScanEntry,
  ProjectSummary,
  Settings,
  TrashItem,
} from "./types";

export const artlog = {
  listProjects: (root: string) =>
    invoke<ProjectSummary[]>("list_projects", { root }),
  openClip: (path: string) => invoke<ProjectView>("open_clip", { path }),
  openContainerProject: (root: string, id: string) =>
    invoke<ProjectView>("open_container_project", { root, id }),
  closeProject: () => invoke<void>("close_project"),
  projectView: (projectId: string) =>
    invoke<ProjectView>("project_view", { projectId }),
  projectState: (projectId: string) =>
    invoke<ProjectState>("project_state", { projectId }),
  projectFiles: (projectId: string) =>
    invoke<ScanEntry[]>("project_files", { projectId }),
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
  createCheckpoint: (projectId: string, title: string, note: string) =>
    invoke<ProjectView>("create_checkpoint", { projectId, title, note }),
  saveSettings: (projectId: string, settings: Settings) =>
    invoke<ProjectView>("save_settings", { projectId, settings }),
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
  attachPreview: (
    projectId: string,
    id: string,
    path: string,
    imagePath: string,
  ) => invoke<Preview>("attach_preview", { projectId, id, path, imagePath }),
  stopTracking: (projectId: string, fileId: string) =>
    invoke<ProjectView>("stop_tracking", { projectId, fileId }),
  relinkFile: (projectId: string, fileId: string, destination: string) =>
    invoke<ProjectView>("relink_file", { projectId, fileId, destination }),
  renameProject: (projectId: string, name: string) =>
    invoke<ProjectView>("rename_project", { projectId, name }),
  deleteFileHistory: (
    projectId: string,
    fileId: string,
    confirmation: string,
  ) =>
    invoke<ProjectView>("delete_file_history", {
      projectId,
      fileId,
      confirmation,
    }),
  removeProject: (projectId: string, confirmation: string) =>
    invoke<void>("remove_project", { projectId, confirmation }),
  listTrash: (root: string) => invoke<TrashItem[]>("list_trash", { root }),
  restoreTrash: (root: string, id: string) =>
    invoke<ProjectView>("restore_trash", { root, id }),
  purgeTrash: (root: string, id: string, confirmation: string) =>
    invoke<void>("purge_trash", { root, id, confirmation }),
};
