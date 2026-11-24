import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, CommitThumbnail } from "../types";
import { HistoryTimeline } from "./History";

const { getThumbnail } = vi.hoisted(() => ({ getThumbnail: vi.fn() }));

vi.mock("../api", () => ({
  artlog: { getCommitThumbnail: getThumbnail },
}));

const commits: CommitSummary[] = [
  {
    id: "second",
    parent: "first",
    timestamp: "2026-11-17T12:00:00Z",
    title: "Approved line art",
    note: "",
    kind: "checkpoint",
    fileCount: 1,
  },
  {
    id: "first",
    parent: null,
    timestamp: "2026-11-16T12:00:00Z",
    title: "Initial snapshot",
    note: "",
    kind: "baseline",
    fileCount: 1,
  },
];

function thumbnail(path: string, dataUrl: string): CommitThumbnail {
  return {
    path,
    dataUrl,
    width: 160,
    height: 100,
    adapter: "clip",
    adapterVersion: 1,
  };
}

const observers: VisibilityObserver[] = [];

class VisibilityObserver {
  element: Element | null = null;

  constructor(private callback: IntersectionObserverCallback) {
    observers.push(this);
  }

  observe(element: Element) {
    this.element = element;
  }

  disconnect() {}

  show() {
    this.callback(
      [
        {
          isIntersecting: true,
          target: this.element,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

describe("History thumbnails", () => {
  beforeEach(() => {
    observers.length = 0;
    getThumbnail.mockReset();
    vi.stubGlobal("IntersectionObserver", VisibilityObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads visible versions and binds the thumbnail to the saved version", async () => {
    getThumbnail.mockResolvedValue(
      thumbnail("drawing.clip", "data:image/png;base64,second"),
    );
    const select = vi.fn();
    render(
      <HistoryTimeline
        projectId="project"
        commits={commits}
        selectedId="second"
        onSelect={select}
      />,
    );

    expect(getThumbnail).not.toHaveBeenCalled();
    act(() => observers[0].show());
    const image = await screen.findByRole("img", {
      name: "Thumbnail of drawing.clip for Approved line art",
    });
    expect(image).toHaveAttribute("src", "data:image/png;base64,second");
    expect(getThumbnail).toHaveBeenCalledExactlyOnceWith("project", "second");
    expect(
      screen.getByRole("img", {
        name: "Loading thumbnail for Initial snapshot",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /approved line art/i }));
    expect(select).toHaveBeenCalledWith("second");
  });

  it("ignores a late thumbnail from a previous project with the same version id", async () => {
    let finishOld: (value: CommitThumbnail) => void = () => {};
    let finishNew: (value: CommitThumbnail) => void = () => {};
    getThumbnail
      .mockImplementationOnce(
        () =>
          new Promise<CommitThumbnail>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<CommitThumbnail>((resolve) => {
            finishNew = resolve;
          }),
      );
    const props = {
      commits: commits.slice(0, 1),
      selectedId: "second",
      onSelect: vi.fn(),
    };
    const { rerender } = render(
      <HistoryTimeline projectId="old-project" {...props} />,
    );
    act(() => observers[0].show());
    rerender(<HistoryTimeline projectId="new-project" {...props} />);
    act(() => observers[1].show());
    await act(async () =>
      finishOld(thumbnail("old.clip", "data:image/png;base64,old")),
    );
    expect(
      screen.queryByRole("img", { name: /thumbnail of old.clip/i }),
    ).toBeNull();
    await act(async () =>
      finishNew(thumbnail("new.clip", "data:image/png;base64,new")),
    );
    expect(
      await screen.findByRole("img", {
        name: "Thumbnail of new.clip for Approved line art",
      }),
    ).toHaveAttribute("src", "data:image/png;base64,new");
    expect(getThumbnail.mock.calls).toEqual([
      ["old-project", "second"],
      ["new-project", "second"],
    ]);
  });

  it("keeps version selection available after a thumbnail failure", async () => {
    getThumbnail.mockRejectedValue(new Error("Preview cannot be decoded"));
    const select = vi.fn();
    render(
      <HistoryTimeline
        projectId="project"
        commits={commits.slice(0, 1)}
        selectedId="second"
        onSelect={select}
      />,
    );
    act(() => observers[0].show());
    await screen.findByRole("img", {
      name: "Thumbnail unavailable for Approved line art",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /approved line art/i }));
    expect(select).toHaveBeenCalledWith("second");
  });
});
