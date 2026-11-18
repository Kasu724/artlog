import { invoke } from "@tauri-apps/api/core";
import type {
  CommitThumbnail,
  FileVersion,
  Preview,
  ProjectView,
  ProjectState,
  RepositoryHealth,
  RestoreOutcome,
  ScanEntry,
  ScanResult,
  Settings,
} from "./types";

export const artlog = {
  scanProject: (root: string) => invoke<ScanResult>("scan_project", { root }),
  activateProject: (root: string, tracked: string[] | null) =>
    invoke<ProjectView>("activate_project", { root, tracked }),
  closeProject: () => invoke<void>("close_project"),
  projectView: (projectId: string) =>
    invoke<ProjectView>("project_view", { projectId }),
  projectState: (projectId: string) =>
    invoke<ProjectState>("project_state", { projectId }),
  projectFiles: (projectId: string) =>
    invoke<ScanEntry[]>("project_files", { projectId }),
  commitFiles: (projectId: string, id: string) =>
    invoke<FileVersion[]>("list_commit_files", { projectId, id }),
  comparisonVersions: (projectId: string, path: string) =>
    invoke<string[]>("comparison_versions", { projectId, path }),
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
  getCommitThumbnail: (projectId: string, id: string) =>
    invoke<CommitThumbnail | null>("get_commit_thumbnail", { projectId, id }),
  attachPreview: (
    projectId: string,
    id: string,
    path: string,
    imagePath: string,
  ) => invoke<Preview>("attach_preview", { projectId, id, path, imagePath }),
};
