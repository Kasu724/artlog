# ArtLog releases

## Unreleased

- Open a single `.clip` directly or select related files for a shared folder
  project. Both project types can coexist in the same folder.
- Keep stable file identities, file-specific history and previews, and
  project-local chunk reuse. Upgrade earlier projects while preserving their
  checkpoint IDs.
- Stop tracking a file, delete its active history, or remove a project.
  Recover archives from ArtLog trash or permanently delete them with a
  separate confirmation.
- Generate thumbnails automatically from saved `.clip` canvas previews and
  display them in History, including existing checkpoints.
- Track and capture Clip Studio Paint (`.clip`) files. Attach PNG or JPEG
  exports for visual comparisons.
- Restore historical files of other formats as verified copies.

## 0.1.0

- Start or reopen a local project, select artwork and companion files, and
  browse exact history on `main`.
- Capture settled saves automatically, reconcile changes on reopen, and name
  checkpoints with notes.
- View compatible PSD previews or attach PNG/JPEG exports. Compare matching
  versions with linked navigation, overlay, or pixel difference.
- Restore a verified copy, or replace a closed working file after saving a
  safety checkpoint. Interrupted replacements retain recovery information.
- Check repository integrity and back up portable history by copying the
  project and its `.artlog/` folder.

The Windows x64 bundle is an unsigned NSIS installer and expects WebView2.
The macOS DMG workflow is configured; a macOS host and signing credentials
are needed to complete macOS launch, editor, and distribution verification.
Windows smoke coverage uses a real save from Clip Studio Paint and a synthetic
PSD fixture. The final build reopened history, rendered a PSD comparison,
and passed independent byte checks for a restored copy, an in-place
replacement, and its safety checkpoint. Photoshop itself was not available
on the Windows test host. WebView2 opened its own outbound connections
during the smoke test, so this is not a zero-egress certification.
