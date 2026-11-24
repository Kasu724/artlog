import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./project-management.css";

type DeleteHistoryProps = {
  filename: string;
  location: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
};

export function DeleteHistoryDialog(props: DeleteHistoryProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isOpen = !!props.filename;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog restore-dialog"
      aria-labelledby="delete-history-title"
      aria-describedby="delete-history-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!props.busy) props.onCancel();
      }}
    >
      {isOpen && <DeleteHistoryForm key={props.filename} {...props} />}
    </dialog>
  );
}

function DeleteHistoryForm({
  filename,
  location,
  busy,
  error,
  onCancel,
  onConfirm,
}: DeleteHistoryProps) {
  const [typed, setTyped] = useState("");
  const canConfirm = !busy && typed === filename;

  return (
    <form
      className="delete-history-form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (canConfirm) onConfirm(typed);
      }}
    >
      <h2 id="delete-history-title">Permanently delete file history?</h2>
      <p className="delete-history-location">
        <Icon name="folder" />
        <bdi>{location}</bdi>
      </p>
      <p id="delete-history-description">
        ArtLog will permanently erase the saved versions, titles, and notes for{" "}
        <strong>
          <bdi>{filename}</bdi>
        </strong>
        . Your working file stays in place.
      </p>
      <label className="management-confirmation">
        Type{" "}
        <strong>
          <bdi>{filename}</bdi>
        </strong>{" "}
        to confirm
        <input
          autoFocus
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button type="submit" className="danger-button" disabled={!canConfirm}>
          {busy ? "Deleting…" : "Permanently delete history"}
        </button>
      </div>
    </form>
  );
}
