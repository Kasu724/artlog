import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ProjectView, ScanEntry } from "../types";

const { invokeMock, openMock, saveMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openMock,
  save: saveMock,
}));

const files: ScanEntry[] = [
  { path: "painting.clip", artwork: true, size: 24576 },
  { path: "references/photo.jpg", artwork: false, size: 8192 },
];

function project(commits: ProjectView["commits"]): ProjectView {
  return {
    id: "project-1",
    root: "C:\\art\\moss study",
    name: "moss study",
    settings: {
      tracked: ["painting.clip"],
      autoCapture: true,
      debounceMs: 1200,
    },
    size: 2048,
    recoveryPaths: [],
    commits,
  };
}

const firstCommit = {
  id: "v1",
  parent: null,
  timestamp: "2026-11-15T12:30:00Z",
  title: "Project created",
  note: "Initial snapshot",
  kind: "baseline" as const,
  fileCount: 1,
};

const secondCommit = {
  id: "v2",
  parent: "v1",
  timestamp: "2026-11-16T12:30:00Z",
  title: "Softened the background",
  note: "Tried a quieter palette",
  kind: "checkpoint" as const,
  fileCount: 1,
};

function wireProject(result = project([secondCommit, firstCommit])) {
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case "scan_project":
        return Promise.resolve({ exists: true, files: [] });
      case "activate_project":
        return Promise.resolve(result);
      case "project_files":
        return Promise.resolve(files);
      case "repository_health":
        return Promise.resolve({ versions: result.commits.length, objects: 2 });
      case "list_commit_files":
        return Promise.resolve([
          { path: "painting.clip", size: 24576, hash: "abcdef0123456789" },
        ]);
      case "project_view":
        return Promise.resolve(result);
      case "create_checkpoint":
        return Promise.resolve(result);
      case "restore_copy":
        return Promise.resolve("C:\\art\\painting-restored.clip");
      case "save_settings":
        return Promise.resolve(result);
      case "close_project":
        return Promise.resolve();
      default:
        return Promise.reject(new Error(`Unexpected command: ${command}`));
    }
  });
  openMock.mockResolvedValue("C:\\art\\moss study");
}

async function openExistingProject() {
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: /open a project folder/i }),
  );
  await screen.findByRole("heading", { name: "moss study" });
}

describe("ArtLog desktop workflows", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    saveMock.mockReset();
    wireProject();
  });

  it("explains local storage and offers a project folder action", () => {
    render(<App />);
    expect(
      screen.getByRole("button", { name: /open a project folder/i }),
    ).toBeTruthy();
    expect(screen.getByText(/your files stay on this device/i)).toBeTruthy();
  });

  it("opens an existing project and shows its main timeline", async () => {
    await openExistingProject();
    expect(screen.getByRole("heading", { name: "Timeline" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /softened the background/i }),
    ).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("activate_project", {
      root: "C:\\art\\moss study",
      tracked: null,
    });
  });

  it("lets an artist include companion files while creating a project", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_project")
        return Promise.resolve({ exists: false, files });
      if (command === "activate_project")
        return Promise.resolve(project([firstCommit]));
      if (command === "project_files") return Promise.resolve(files);
      if (command === "repository_health")
        return Promise.resolve({ versions: 1, objects: 1 });
      if (command === "list_commit_files")
        return Promise.resolve([
          { path: "painting.clip", size: 24576, hash: "a".repeat(64) },
        ]);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: /open a project folder/i }),
    );
    await screen.findByRole("heading", { name: /choose what artlog tracks/i });
    fireEvent.click(screen.getByLabelText("references/photo.jpg"));
    fireEvent.click(
      screen.getByRole("button", { name: /create artlog project/i }),
    );
    await screen.findByRole("heading", { name: "Timeline" });
    expect(invokeMock).toHaveBeenCalledWith("activate_project", {
      root: "C:\\art\\moss study",
      tracked: ["painting.clip", "references/photo.jpg"],
    });
  });

  it("saves a named checkpoint and updates the timeline", async () => {
    const updated = project([
      { ...secondCommit, id: "v3", title: "Line art approved" },
      secondCommit,
      firstCommit,
    ]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_project")
        return Promise.resolve({ exists: true, files: [] });
      if (command === "activate_project")
        return Promise.resolve(project([secondCommit, firstCommit]));
      if (command === "project_files") return Promise.resolve(files);
      if (command === "repository_health")
        return Promise.resolve({ versions: 2, objects: 2 });
      if (command === "list_commit_files")
        return Promise.resolve([
          { path: "painting.clip", size: 24576, hash: "a".repeat(64) },
        ]);
      if (command === "create_checkpoint") return Promise.resolve(updated);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    await openExistingProject();
    fireEvent.click(screen.getByRole("button", { name: "Create checkpoint" }));
    fireEvent.change(screen.getByLabelText(/checkpoint name/i), {
      target: { value: "Line art approved" },
    });
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "Ready to color" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save checkpoint/i }));
    await screen.findByRole("button", { name: /line art approved/i });
    expect(invokeMock).toHaveBeenCalledWith("create_checkpoint", {
      projectId: "project-1",
      title: "Line art approved",
      note: "Ready to color",
    });
  });

  it("makes restore as copy the primary action and chooses a new destination", async () => {
    saveMock.mockResolvedValue("C:\\art\\painting-restored.clip");
    await openExistingProject();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /restore as a copy/i })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /restore as a copy/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("restore_copy", {
        projectId: "project-1",
        id: "v2",
        path: "painting.clip",
        destination: "C:\\art\\painting-restored.clip",
      }),
    );
    expect(screen.getByText(/restored a verified copy/i)).toBeTruthy();
  });

  it("requires confirmation before in-place replacement and reports the safety snapshot", async () => {
    const outcome = {
      path: "painting.clip",
      safetyId: "safe1234",
      commitId: "restore123",
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_project")
        return Promise.resolve({ exists: true, files: [] });
      if (command === "activate_project")
        return Promise.resolve(project([secondCommit, firstCommit]));
      if (command === "project_files") return Promise.resolve(files);
      if (command === "repository_health")
        return Promise.resolve({ versions: 2, objects: 2 });
      if (command === "list_commit_files")
        return Promise.resolve([
          { path: "painting.clip", size: 24576, hash: "a".repeat(64) },
        ]);
      if (command === "restore_in_place") return Promise.resolve(outcome);
      if (command === "project_view")
        return Promise.resolve(project([secondCommit, firstCommit]));
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    await openExistingProject();
    const replace = screen.getByRole("button", {
      name: /replace working file/i,
    });
    await waitFor(() => expect(replace.hasAttribute("disabled")).toBe(false));
    fireEvent.click(replace);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        /close it in photoshop or clip studio paint first/i,
      ),
    ).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: /replace with this version/i,
    });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("restore_in_place", {
        projectId: "project-1",
        id: "v2",
        path: "painting.clip",
        confirmedTarget: "painting.clip",
      }),
    );
    expect(await screen.findByText(/safety snapshot saved/i)).toBeTruthy();
  });

  it("saves tracking and automatic-capture settings", async () => {
    const saved = project([secondCommit, firstCommit]);
    saved.settings = {
      tracked: ["painting.clip", "references/photo.jpg"],
      autoCapture: false,
      debounceMs: 2500,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_project")
        return Promise.resolve({ exists: true, files: [] });
      if (command === "activate_project")
        return Promise.resolve(project([secondCommit, firstCommit]));
      if (command === "project_files") return Promise.resolve(files);
      if (command === "repository_health")
        return Promise.resolve({ versions: 2, objects: 2 });
      if (command === "list_commit_files")
        return Promise.resolve([
          { path: "painting.clip", size: 24576, hash: "a".repeat(64) },
        ]);
      if (command === "save_settings") return Promise.resolve(saved);
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    await openExistingProject();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Automatic capture"));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2500" } });
    fireEvent.click(screen.getByLabelText("references/photo.jpg"));
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        projectId: "project-1",
        settings: {
          tracked: ["painting.clip", "references/photo.jpg"],
          autoCapture: false,
          debounceMs: 2500,
        },
      }),
    );
  });
});
