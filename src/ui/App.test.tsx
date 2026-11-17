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

const files: ScanEntry[] = [{ path: "painting.clip", size: 24576 }];

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
      case "comparison_versions":
        return Promise.resolve(result.commits.map((commit) => commit.id));
      case "get_preview":
        return Promise.resolve(null);
      case "attach_preview":
        return Promise.resolve({
          dataUrl: "data:image/png;base64,AA==",
          width: 32,
          height: 32,
          adapter: "export",
          adapterVersion: 1,
        });
      case "project_view":
        return Promise.resolve(result);
      case "project_state":
        return Promise.resolve({
          head: result.commits[0]?.id ?? null,
          capture: {
            projectId: result.id,
            state: "current",
            message: "Up to date",
          },
        });
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
    expect(screen.getByText(/stored on this device/i)).toBeTruthy();
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

  it("selects discovered Clip Studio Paint files when creating a project", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_project")
        return Promise.resolve({ exists: false, files });
      if (command === "activate_project")
        return Promise.resolve(project([firstCommit]));
      if (command === "project_files") return Promise.resolve(files);
      if (command === "project_state")
        return Promise.resolve({
          head: "baseline",
          capture: {
            projectId: "project-1",
            state: "current",
            message: "Up to date",
          },
        });
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
    await screen.findByRole("heading", { name: /files to track/i });
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));
    await screen.findByRole("heading", { name: "Timeline" });
    expect(invokeMock).toHaveBeenCalledWith("activate_project", {
      root: "C:\\art\\moss study",
      tracked: ["painting.clip"],
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
      if (command === "project_state")
        return Promise.resolve({
          head: "v2",
          capture: {
            projectId: "project-1",
            state: "current",
            message: "Up to date",
          },
        });
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

  it("keeps exact restore available when a preview is unavailable", async () => {
    await openExistingProject();
    expect(
      await screen.findByText(/no preview saved for this version/i),
    ).toBeTruthy();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_preview", {
        projectId: "project-1",
        id: "v2",
        path: "painting.clip",
      }),
    );
    expect(
      screen
        .getByRole("button", { name: /restore as a copy/i })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("attaches a chosen PNG export to the selected version and file", async () => {
    openMock
      .mockResolvedValueOnce("C:\\art\\moss study")
      .mockResolvedValueOnce("C:\\art\\flattened.png");
    await openExistingProject();
    await screen.findByText(/no preview saved for this version/i);
    fireEvent.click(
      screen.getByRole("button", { name: /attach png\/jpeg export/i }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("attach_preview", {
        projectId: "project-1",
        id: "v2",
        path: "painting.clip",
        imagePath: "C:\\art\\flattened.png",
      }),
    );
    expect(
      await screen.findByText(
        /artist-provided png\/jpeg export · approximate visual reference/i,
      ),
    ).toBeTruthy();
  });

  it("compares a matching earlier version with shared zoom controls", async () => {
    const preview = {
      dataUrl: "data:image/png;base64,AA==",
      width: 32,
      height: 32,
      adapter: "export" as const,
      adapterVersion: 1,
    };
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "scan_project":
            return Promise.resolve({ exists: true, files: [] });
          case "activate_project":
            return Promise.resolve(project([secondCommit, firstCommit]));
          case "project_files":
            return Promise.resolve(files);
          case "project_state":
            return Promise.resolve({
              head: "v2",
              capture: {
                projectId: "project-1",
                state: "current",
                message: "Up to date",
              },
            });
          case "comparison_versions":
            return Promise.resolve(["v1", "v2"]);
          case "repository_health":
            return Promise.resolve({ versions: 2, objects: 2 });
          case "list_commit_files":
            return Promise.resolve([
              { path: "painting.clip", size: 24576, hash: "a".repeat(64) },
            ]);
          case "get_preview":
            return Promise.resolve(preview);
          default:
            return Promise.reject(
              new Error(
                `Unexpected command: ${command} ${JSON.stringify(args)}`,
              ),
            );
        }
      },
    );
    await openExistingProject();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /compare with another version/i }),
      ).toBeEnabled(),
    );
    const compareButton = screen.getByRole("button", {
      name: /compare with another version/i,
    });
    fireEvent.click(compareButton);
    const selector = await screen.findByRole("combobox", {
      name: /compare with version/i,
    });
    await waitFor(() =>
      expect(
        within(selector).getByRole("option", { name: /project created/i }),
      ).toBeTruthy(),
    );
    expect(
      within(selector).queryByRole("option", {
        name: /softened the background/i,
      }),
    ).toBeNull();
    fireEvent.change(selector, { target: { value: "v1" } });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("get_preview", {
        projectId: "project-1",
        id: "v1",
        path: "painting.clip",
      }),
    );
    expect(await screen.findByRole("button", { name: "Overlay" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Difference" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("115%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom and pan" }));
    expect(screen.getByText("100%")).toBeTruthy();
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
      if (command === "project_state")
        return Promise.resolve({
          head: "v2",
          capture: {
            projectId: "project-1",
            state: "current",
            message: "Up to date",
          },
        });
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
    const replace = await screen.findByRole("button", {
      name: /replace working file/i,
    });
    await waitFor(() => expect(replace.hasAttribute("disabled")).toBe(false));
    fireEvent.click(replace);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/close it in clip studio paint first/i),
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
      tracked: ["painting.clip"],
      autoCapture: false,
      debounceMs: 2500,
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_project")
        return Promise.resolve({ exists: true, files: [] });
      if (command === "activate_project")
        return Promise.resolve(project([secondCommit, firstCommit]));
      if (command === "project_files") return Promise.resolve(files);
      if (command === "project_state")
        return Promise.resolve({
          head: "v2",
          capture: {
            projectId: "project-1",
            state: "current",
            message: "Up to date",
          },
        });
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
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        projectId: "project-1",
        settings: {
          tracked: ["painting.clip"],
          autoCapture: false,
          debounceMs: 2500,
        },
      }),
    );
  });

  it("keeps historical non-CLIP files copy-only and without previews", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "scan_project":
          return Promise.resolve({ exists: true, files: [] });
        case "activate_project":
          return Promise.resolve(project([secondCommit, firstCommit]));
        case "project_files":
          return Promise.resolve(files);
        case "project_state":
          return Promise.resolve({
            head: "v2",
            capture: {
              projectId: "project-1",
              state: "current",
              message: "Up to date",
            },
          });
        case "repository_health":
          return Promise.resolve({ versions: 2, objects: 2 });
        case "list_commit_files":
          return Promise.resolve([
            { path: "old-work.psd", size: 128, hash: "b".repeat(64) },
          ]);
        case "restore_copy":
          return Promise.resolve("C:\\art\\old-work-copy.psd");
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });
    saveMock.mockResolvedValue("C:\\art\\old-work-copy.psd");
    await openExistingProject();
    expect(await screen.findByText("ARCHIVED FILE")).toBeTruthy();
    expect(screen.getByText("old-work.psd")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /replace working file/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /attach png\/jpeg export/i }),
    ).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "get_preview",
      expect.anything(),
    );
    fireEvent.click(screen.getByRole("button", { name: /restore as a copy/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("restore_copy", {
        projectId: "project-1",
        id: "v2",
        path: "old-work.psd",
        destination: "C:\\art\\old-work-copy.psd",
      }),
    );
  });
});
