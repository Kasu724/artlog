export type Settings = {
  tracked: string[];
  autoCapture: boolean;
  debounceMs: number;
};

export type CaptureState =
  "pending" | "capturing" | "current" | "paused" | "error";

export type CaptureStatus = {
  projectId: string;
  state: CaptureState;
  message: string;
};

export type ProjectState = { head: string | null; capture: CaptureStatus };

export type CommitKind =
  "baseline" | "auto" | "checkpoint" | "safety" | "restore";

export type CommitSummary = {
  id: string;
  parent: string | null;
  timestamp: string;
  title: string;
  note: string;
  kind: CommitKind;
  fileCount: number;
};

export type ProjectView = {
  id: string;
  root: string;
  name: string;
  settings: Settings;
  size: number;
  recoveryPaths: string[];
  commits: CommitSummary[];
  capture?: CaptureStatus;
  project: ProjectSummary;
  files: ProjectFile[];
  openWarning?: string;
  metadata: string;
};

export type ScanEntry = {
  path: string;
  size: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  mode: "folder" | "singleFile";
  path: string | null;
  recovered?: boolean;
};

export type ProjectFile = {
  id: string;
  path: string;
  tracked: boolean;
  hasHistory: boolean;
  present: boolean;
};

export type ScanResult = {
  exists: boolean;
  files: ScanEntry[];
  projects?: ProjectSummary[];
};

export type FileLocation = {
  root: string;
  path: string;
  existing: ProjectSummary | null;
  folders: ProjectSummary[];
  shared: boolean;
};

export type TrashItem = {
  id: string;
  projectId: string;
  projectName: string;
  filePath: string | null;
  removedAt: string;
  size: number;
  kind: "project" | "fileHistory";
  activeSize: number | null;
  purgePending: boolean;
};

export type FileVersion = {
  path: string;
  size: number;
  hash: string;
  fileId?: string | null;
};

export type RestoreOutcome = {
  path: string;
  safetyId: string;
  commitId: string;
};

export type RepositoryHealth = { versions: number; objects: number };

export type Preview = {
  dataUrl: string;
  width: number;
  height: number;
  adapter: "clip" | "export";
  adapterVersion: number;
};

export type CommitThumbnail = Preview & { path: string };
export type ComparisonVersion = { id: string; path: string };

export type ViewName = "history" | "files" | "settings";
