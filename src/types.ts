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
};

export type ScanEntry = {
  path: string;
  artwork: boolean;
  size: number;
};

export type ScanResult = { exists: boolean; files: ScanEntry[] };

export type FileVersion = {
  path: string;
  size: number;
  hash: string;
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
  adapter: "psd" | "export";
  adapterVersion: string;
};

export type ViewName = "history" | "files" | "settings";
