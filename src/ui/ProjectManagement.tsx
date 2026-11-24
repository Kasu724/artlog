import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TrashItem } from "../types";
import { formatBytes, formatDate } from "./format";
import { Icon } from "./Icon";
import "./project-management.css";

export type ManagementAction = {
  kind: "stop" | "deleteFile" | "removeProject" | "purge" | "restoreTrash";
  subject: string;
  location: string;
  required?: string;
  estimatedReclaim?: number;
};

const actionCopy = {
  stop: {
    label: "Stop tracking",
    description:
      "ArtLog will stop capturing saves for this file. You can still browse and restore its saved versions, and resume tracking later.",
  },
  deleteFile: {
    label: "Delete file history",
    description:
      "ArtLog moves a copy of the project’s current history to recoverable trash, removes this file’s versions from the active timeline, and stops tracking it. Working artwork and other files’ versions stay in place. Checkpoint IDs may change.",
  },
  removeProject: {
    label: "Remove project",
    description:
      "ArtLog moves this project’s history and settings to recoverable trash. Working artwork and other projects stay in place.",
  },
  purge: {
    label: "Permanently delete",
    description:
      "This permanently erases the archived history from ArtLog trash. Working artwork stays in place.",
  },
  restoreTrash: {
    label: "Restore from trash",
    description:
      "ArtLog restores the archived project history. If the active project has changed since removal, ArtLog can recover the archive as a separate project.",
  },
};

export function TrashView({
  root,
  items,
  loading,
  error,
  busy,
  onBack,
  onRetry,
  onRestore,
  onPurge,
}: {
  root: string;
  items: TrashItem[];
  loading: boolean;
  error: string;
  busy: boolean;
  onBack: () => void;
  onRetry: () => void;
  onRestore: (item: TrashItem) => void;
  onPurge: (item: TrashItem) => void;
}) {
  return (
    <section
      className="library-view trash-view"
      aria-labelledby="trash-heading"
    >
      <button
        type="button"
        className="quiet-button back-button"
        onClick={onBack}
        disabled={busy}
      >
        <span aria-hidden="true">←</span> Back
      </button>
      <h1 className="page-heading" id="trash-heading">
        ArtLog trash
      </h1>
      <p className="library-location" title={root}>
        <Icon name="folder" />
        <bdi>{root}</bdi>
      </p>
      {loading && <p role="status">Loading trash…</p>}
      {error && (
        <div className="error-message" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="text-button"
            onClick={onRetry}
            disabled={busy || loading}
          >
            Retry
          </button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <p className="trash-empty">Trash is empty for this folder.</p>
      )}
      {items.length > 0 && (
        <table
          className="trash-register"
          role="table"
          aria-label="Archived histories"
        >
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                No.
              </th>
              <th scope="col" role="columnheader">
                Item
              </th>
              <th scope="col" role="columnheader">
                Status
              </th>
              <th scope="col" role="columnheader">
                Actions
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {items.map((item, index) => {
              const date = formatDate(item.removedAt);
              const subject = item.filePath ?? item.projectName;
              return (
                <tr key={item.id} role="row">
                  <td className="register-number trash-item-number" role="cell">
                    {String(index + 1).padStart(2, "0")}
                  </td>
                  <th scope="row" role="rowheader">
                    <div className="trash-item-details">
                      <Icon
                        name={item.kind === "fileHistory" ? "file" : "folder"}
                      />
                      <div>
                        <h2>
                          <bdi>{subject}</bdi>
                        </h2>
                        {item.filePath && (
                          <p>
                            File history from <bdi>{item.projectName}</bdi>
                          </p>
                        )}
                        <p className="trash-item-meta">
                          <time dateTime={item.removedAt} title={date.full}>
                            Removed {date.day} {date.time}
                          </time>
                          <span>{formatBytes(item.size)} archived</span>
                          {item.activeSize != null && (
                            <span>
                              {formatBytes(item.activeSize)} in project after
                              removal
                            </span>
                          )}
                        </p>
                        {item.purgePending && (
                          <p className="trash-item-warning">
                            Permanent deletion was interrupted. You can finish
                            deleting this archive.
                          </p>
                        )}
                      </div>
                    </div>
                  </th>
                  <td role="cell" className="trash-item-status">
                    <span
                      className={
                        item.purgePending
                          ? "trash-status purge-pending"
                          : "trash-status"
                      }
                    >
                      {item.purgePending ? "Deletion interrupted" : "Archived"}
                    </span>
                  </td>
                  <td role="cell" className="trash-actions-cell">
                    <div className="trash-item-actions">
                      {!item.purgePending && (
                        <button
                          type="button"
                          className="secondary-button trash-restore-action"
                          aria-label={`Restore from trash — ${subject}`}
                          onClick={() => onRestore(item)}
                          disabled={busy || loading}
                        >
                          Restore from trash
                        </button>
                      )}
                      <button
                        type="button"
                        className="quiet-button trash-delete-action"
                        aria-label={`Permanently delete — ${subject}`}
                        onClick={() => onPurge(item)}
                        disabled={busy || loading}
                      >
                        Permanently delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

type ConfirmationProps = {
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
};

export function ConfirmationDialog({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
}: ConfirmationProps & { action: ManagementAction | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isOpen = action !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog"
      aria-labelledby="management-title"
      aria-describedby="management-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      {action && (
        <ConfirmationForm
          key={JSON.stringify([
            action.kind,
            action.subject,
            action.location,
            action.required,
          ])}
          action={action}
          busy={busy}
          error={error}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </dialog>
  );
}

function ConfirmationForm({
  action,
  busy,
  error,
  onCancel,
  onConfirm,
}: ConfirmationProps & { action: ManagementAction }) {
  const [typed, setTyped] = useState("");
  const { label, description } = actionCopy[action.kind];
  const canConfirm =
    !busy && (action.required === undefined || typed === action.required);
  const destructive =
    action.kind === "deleteFile" ||
    action.kind === "removeProject" ||
    action.kind === "purge";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canConfirm) onConfirm(typed);
  }

  return (
    <form className="management-form" onSubmit={submit} aria-busy={busy}>
      <h2 id="management-title">{label}?</h2>
      <p className="management-subject">
        <strong>
          <bdi>{action.subject}</bdi>
        </strong>
      </p>
      <p className="trash-location" title={action.location}>
        <Icon name="folder" />
        <bdi>{action.location}</bdi>
      </p>
      <p id="management-description">{description}</p>
      {action.estimatedReclaim != null && (
        <p>
          Estimated space you can reclaim {formatBytes(action.estimatedReclaim)}
          .
        </p>
      )}
      {action.required !== undefined && (
        <label className="management-confirmation">
          Type{" "}
          <strong>
            <bdi>{action.required}</bdi>
          </strong>{" "}
          to confirm
          <input
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-initial-focus
            disabled={busy}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          data-initial-focus={action.required === undefined ? true : undefined}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="submit"
          className={destructive ? "danger-button" : "primary-button"}
          disabled={!canConfirm}
        >
          {busy ? "Working…" : label}
        </button>
      </div>
    </form>
  );
}
