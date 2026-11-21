import type { ProjectSummary, ProjectView } from "../types";

export type RecentProject = {
  root: string;
  id: string;
  name: string;
  mode: ProjectSummary["mode"];
};

const STORAGE_KEY = "artlog.recent-projects.v1";
const MAX_RECENT_PROJECTS = 8;

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<RecentProject>;
  return (
    typeof item.root === "string" &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.mode === "folder" || item.mode === "singleFile")
  );
}

export function readRecentProjects(): RecentProject[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const projects: RecentProject[] = [];
    for (const item of value) {
      if (!isRecentProject(item)) continue;
      const key = JSON.stringify([item.root, item.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({
        root: item.root,
        id: item.id,
        name: item.name,
        mode: item.mode,
      });
      if (projects.length === MAX_RECENT_PROJECTS) break;
    }
    return projects;
  } catch {
    return [];
  }
}

export function writeRecentProjects(projects: RecentProject[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Recent projects are a convenience and must not interrupt opening a project.
  }
}

export function rememberRecentProject(
  projects: RecentProject[],
  project: ProjectView,
): RecentProject[] {
  const recent: RecentProject = {
    root: project.root,
    id: project.project.id,
    name: project.name,
    mode: project.project.mode,
  };
  const key = JSON.stringify([recent.root, recent.id]);
  return [
    recent,
    ...projects.filter((item) => JSON.stringify([item.root, item.id]) !== key),
  ].slice(0, MAX_RECENT_PROJECTS);
}
