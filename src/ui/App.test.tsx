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
    metadata: "C:\\art\\moss study\\.artlog",
    name: "moss study",
    settings: {
      tracked: ["painting.clip"],
      autoCapture: true,
      debounceMs: 1200,
    },
    size: 2048,
    historyCompression: true,
    canRepackHistory: true,
    recoveryPaths: [],
    commits,
    project: {
      id: "repository-1",
      name: "moss study",
      mode: "singleFile",
      path: "painting.clip",
    },
    files: [],
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
      case "list_projects":
        return Promise.resolve([result.project]);
      case "open_container_project":
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
        return Promise.resolve(
          result.commits.map((commit) => ({
            id: commit.id,
            path: "painting.clip",
          })),
        );
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
    screen.getByRole("button", { name: /browse saved histories/i }),
  );
  fireEvent.click(await screen.findByRole("button", { name: /moss study/i }));
  await screen.findByRole("heading", { name: "moss study" });
}

describe("ArtLog desktop workflows", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    openMock.mockReset();
    saveMock.mockReset();
    wireProject();
  });

  it("opens Clip files directly and offers saved history browsing", () => {
    render(<App />);
    expect(
      screen.getByRole("button", { name: /browse saved histories/i }),
    ).toBeTruthy();
    expect(
      screen.getByText(/projects you open will appear here/i),
    ).toBeVisible();
    expect(screen.queryByText(/stored on this device/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /trash/i })).toBeNull();
  });

  it("reopens a recent project from the sidebar after an app reload", async () => {
    const app = render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: /browse saved histories/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /moss study/i }));
    await screen.findByRole("heading", { name: "moss study" });
    app.unmount();

    openMock.mockClear();
    invokeMock.mockClear();
    render(<App />);
    const sidebar = screen.getByRole("region", { name: "Recently opened" });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "moss study" }),
    );
    await screen.findByRole("heading", { name: "moss study" });
    expect(invokeMock).toHaveBeenCalledWith("open_container_project", {
      root: "C:\\art\\moss study",
      id: "repository-1",
    });
    expect(openMock).not.toHaveBeenCalled();
  });

  it("opens an existing history and shows its main timeline", async () => {
    await openExistingProject();
    expect(screen.getByRole("heading", { name: "History" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /softened the background/i }),
    ).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("open_container_project", {
      root: "C:\\art\\moss study",
      id: "repository-1",
    });
  });

  it("opens saved folder history with capture disabled", async () => {
    const result = project([firstCommit]);
    wireProject({
      ...result,
      project: { ...result.project, mode: "folder", path: null },
      openWarning: "This saved history is read-only.",
    });
    await openExistingProject();
    expect(screen.getByText("This saved history is read-only.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /new checkpoint/i }),
    ).toBeDisabled();
  });

  it("opens the selected .clip file directly", async () => {
    const base = invokeMock.getMockImplementation();
    const result = project([firstCommit]);
    const path = "C:\\art\\moss study\\painting.clip";
    const single: ProjectView = {
      ...result,
      id: "single-session",
      name: "painting.clip",
      project: {
        id: "single-repo",
        name: "painting.clip",
        mode: "singleFile",
        path: "painting.clip",
      },
    };
    openMock.mockResolvedValue(path);
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command === "open_clip") return Promise.resolve(single);
      return base?.(command, args);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a .clip file" }));
    await screen.findByRole("heading", { name: "painting.clip" });
    expect(invokeMock).toHaveBeenCalledWith("open_clip", { path });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "inspect_clip",
      expect.anything(),
    );
  });

  it("reconciles a same-folder rename with an unchanged head and keeps other settings edits", async () => {
    const oldPath = "painting.clip";
    const newPath = "painting-final.clip";
    const original = project([secondCommit, firstCommit]);
    original.project = {
      ...original.project,
      mode: "singleFile",
      path: oldPath,
    };
    original.name = oldPath;
    const renamed: ProjectView = {
      ...original,
      name: newPath,
      project: { ...original.project, path: newPath },
      settings: { ...original.settings, tracked: [newPath] },
      files: [
        {
          id: "file-1",
          path: newPath,
          tracked: true,
          hasHistory: true,
          present: true,
        },
      ],
    };
    let activePath = oldPath;
    const base = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command === "open_clip") return Promise.resolve(original);
      if (command === "project_state")
        return Promise.resolve({
          head: "v2",
          path: activePath,
          capture: {
            projectId: original.id,
            state: "current",
            message: "Up to date",
          },
        });
      if (command === "project_view") return Promise.resolve(renamed);
      if (command === "project_files")
        return Promise.resolve([{ path: activePath, size: 24576 }]);
      return base?.(command, args);
    });
    openMock.mockResolvedValue("C:\\art\\painting.clip");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Open a .clip file" }));
    await screen.findByRole("heading", { name: oldPath });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Automatic capture"));
    activePath = newPath;
    await waitFor(
      () => {
        expect(screen.getByRole("checkbox", { name: newPath })).toBeChecked();
        expect(screen.getByLabelText("Automatic capture")).not.toBeChecked();
      },
      { timeout: 5000 },
    );
    expect(invokeMock).toHaveBeenCalledWith("project_view", {
      projectId: original.id,
    });
    expect(invokeMock).toHaveBeenCalledWith("project_files", {
      projectId: original.id,
    });
    expect(screen.getByRole("heading", { name: newPath })).toBeVisible();
  }, 12000);

  it("relinks a missing file and refreshes the renamed history", async () => {
    const file = {
      id: "stable-file",
      path: "painting.clip",
      present: false,
      tracked: true,
      hasHistory: true,
    };
    const result = { ...project([firstCommit]), files: [file] };
    wireProject(result);
    const base = invokeMock.getMockImplementation();
    const renamed = "cover.clip";
    const destination = `${result.root}\\${renamed}`;
    const linked = {
      ...result,
      id: "relinked-session",
      name: renamed,
      project: { ...result.project, path: renamed, name: renamed },
      files: [{ ...file, path: renamed, present: true }],
      settings: { ...result.settings, tracked: [renamed] },
    };
    invokeMock.mockImplementation((command: string, args: unknown) =>
      command === "relink_file"
        ? Promise.resolve(linked)
        : base?.(command, args),
    );
    await openExistingProject();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    openMock.mockResolvedValueOnce(destination);
    fireEvent.click(screen.getByRole("button", { name: "Link renamed file" }));
    await screen.findByRole("heading", { name: renamed });
    expect(invokeMock).toHaveBeenCalledWith("relink_file", {
      projectId: result.id,
      fileId: file.id,
      destination,
    });
    expect(invokeMock).toHaveBeenCalledWith("project_files", {
      projectId: linked.id,
    });
  });

  it("requires the file name before deletion and refreshes the project session", async () => {
    const file = {
      id: "stable-file",
      path: "painting.clip",
      tracked: true,
      present: true,
      hasHistory: true,
    };
    const original = { ...project([secondCommit, firstCommit]), files: [file] };
    wireProject(original);
    const base = invokeMock.getMockImplementation();
    const cleaned = {
      ...original,
      id: "new-session",
      commits: [{ ...firstCommit, id: "new-head", fileCount: 0 }],
      settings: { ...original.settings, tracked: [] },
      files: [{ ...file, tracked: false, hasHistory: false }],
    };
    invokeMock.mockImplementation(
      (command: string, args: { projectId?: string }) => {
        if (command === "delete_file_history") return Promise.resolve(cleaned);
        if (args?.projectId === cleaned.id && command === "project_state")
          return Promise.resolve({
            head: "new-head",
            capture: {
              projectId: cleaned.id,
              state: "current",
              message: "Up to date",
            },
          });
        return base?.(command, args);
      },
    );
    await openExistingProject();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete file history" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/checkpoint ids may change/i)).toBeVisible();
    const deletion = dialog.getByRole("button", {
      name: "Delete file history",
    });
    expect(deletion).toBeDisabled();
    fireEvent.change(dialog.getByRole("textbox"), {
      target: { value: "painting.clip" },
    });
    fireEvent.click(deletion);
    expect(
      await screen.findByText("File history moved to ArtLog trash."),
    ).toBeVisible();
    expect(invokeMock).toHaveBeenCalledWith("delete_file_history", {
      projectId: original.id,
      fileId: file.id,
      confirmation: "painting.clip",
    });
    expect(
      screen.queryByRole("button", { name: "Delete file history" }),
    ).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("project_files", {
      projectId: cleaned.id,
    });
  });

  it("opens location trash after removing a project and separately confirms permanent deletion", async () => {
    const base = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command === "remove_project" || command === "purge_trash")
        return Promise.resolve();
      if (command === "list_trash")
        return Promise.resolve([
          {
            id: "archive-1",
            projectId: "repository-1",
            projectName: "moss study",
            filePath: null,
            removedAt: "2026-11-18T04:00:00Z",
            size: 2048,
            kind: "project",
            purgePending: false,
          },
        ]);
      return base?.(command, args);
    });
    await openExistingProject();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));
    const removal = within(screen.getByRole("dialog"));
    fireEvent.change(removal.getByRole("textbox"), {
      target: { value: "moss study" },
    });
    fireEvent.click(removal.getByRole("button", { name: "Remove project" }));
    expect(
      await screen.findByRole("heading", { name: "ArtLog trash" }),
    ).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /permanently delete.*moss study/i,
      }),
    );
    const purge = within(screen.getByRole("dialog"));
    const button = purge.getByRole("button", { name: "Permanently delete" });
    fireEvent.change(purge.getByRole("textbox"), {
      target: { value: "delete" },
    });
    expect(button).toBeDisabled();
    fireEvent.change(purge.getByRole("textbox"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(button);
    await screen.findByText("Trash is empty for this folder.");
    expect(invokeMock).toHaveBeenCalledWith("purge_trash", {
      root: "C:\\art\\moss study",
      id: "archive-1",
      confirmation: "DELETE",
    });
  });

  it("lists existing histories in the selected folder without creating folder tracking", async () => {
    const base = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((command: string, args: unknown) => {
      if (command === "list_projects") return Promise.resolve([]);
      return base?.(command, args);
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: /browse saved histories/i }),
    );
    expect(
      await screen.findByText("No saved histories in this folder"),
    ).toBeVisible();
    expect(invokeMock).toHaveBeenCalledWith("list_projects", {
      root: "C:\\art\\moss study",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "activate_project",
      expect.anything(),
    );
  });

  it("saves a named checkpoint and updates the timeline", async () => {
    const updated = project([
      { ...secondCommit, id: "v3", title: "Line art approved" },
      secondCommit,
      firstCommit,
    ]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_projects")
        return Promise.resolve([project([secondCommit, firstCommit]).project]);
      if (command === "open_container_project")
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
    fireEvent.click(screen.getByRole("button", { name: "New checkpoint" }));
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
          case "list_projects":
            return Promise.resolve([
              project([secondCommit, firstCommit]).project,
            ]);
          case "open_container_project":
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
            return Promise.resolve(
              ["v1", "v2"].map((id) => ({ id, path: "painting.clip" })),
            );
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

  it("uses a timeline click for the previous preview without changing the selected checkpoint", async () => {
    await openExistingProject();
    const timeline = screen.getByRole("region", { name: "Version timeline" });
    const current = within(timeline).getByRole("button", {
      name: /softened the background/i,
    });
    const previous = within(timeline).getByRole("button", {
      name: /project created/i,
    });
    const slot = await screen.findByRole("button", {
      name: "Choose previous version from timeline",
    });
    fireEvent.click(slot);
    const selector = await screen.findByRole("combobox", {
      name: /compare with version/i,
    });
    expect(
      selector.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(current).toBeDisabled();
    expect(slot).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(previous).toBeEnabled());
    fireEvent.click(previous);

    await waitFor(() => expect(selector).toHaveValue("v1"));
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(previous).toHaveAttribute("aria-pressed", "false");
    expect(current).toBeEnabled();
    expect(invokeMock).toHaveBeenCalledWith("get_preview", {
      projectId: "project-1",
      id: "v1",
      path: "painting.clip",
    });
  });

  it("requires confirmation before in-place replacement and reports the safety snapshot", async () => {
    const outcome = {
      path: "painting.clip",
      safetyId: "safe1234",
      commitId: "restore123",
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_projects")
        return Promise.resolve([project([secondCommit, firstCommit]).project]);
      if (command === "open_container_project")
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
      if (command === "list_projects")
        return Promise.resolve([project([secondCommit, firstCommit]).project]);
      if (command === "open_container_project")
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

  it("repacks history and turns compression off without saving a tracking draft", async () => {
    wireProject();
    const existing = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(
      (command: string, params?: { mode?: string }) => {
        if (command === "repack_history") {
          return Promise.resolve(
            params?.mode === "raw"
              ? {
                  size: 5000,
                  report: {
                    objectsRewritten: 1,
                    beforeBytes: 500,
                    afterBytes: 4000,
                  },
                }
              : {
                  size: 1500,
                  report: {
                    objectsRewritten: 1,
                    beforeBytes: 4000,
                    afterBytes: 500,
                  },
                },
          );
        }
        if (command === "set_history_compression") return Promise.resolve(5000);
        return existing(command, params);
      },
    );
    await openExistingProject();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Automatic capture"));
    fireEvent.click(
      screen.getByRole("button", { name: "Compress existing history" }),
    );
    expect(await screen.findByText(/history compressed.*bytes/i)).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("repack_history", {
      projectId: "project-1",
      mode: "compress",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Convert history to raw" }),
    );
    expect(await screen.findByText(/raw layout verified/i)).toBeTruthy();
    expect(
      screen.getByLabelText("Compress new content objects"),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Automatic capture")).not.toBeChecked();
    expect(screen.getByText("Unsaved settings")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Compress new content objects"));
    expect(await screen.findByText("History compression is on.")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("set_history_compression", {
      projectId: "project-1",
      enabled: true,
    });
    expect(screen.getByLabelText("Compress new content objects")).toBeChecked();
  });

  it("keeps historical non-CLIP files copy-only and without previews", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "list_projects":
          return Promise.resolve([
            project([secondCommit, firstCommit]).project,
          ]);
        case "open_container_project":
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
    expect(
      await screen.findByRole("heading", { name: "Archived file" }),
    ).toBeTruthy();
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
