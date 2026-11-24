# ArtLog releases

## Unreleased

- Compress eligible history chunks losslessly with Zstandard. Settings can
  repack existing history, disable compression for new objects, or verify a
  conversion back to raw storage before downgrading.
- Open one `.clip` file at a time and reopen recent projects from home.
- Capture stable saves automatically. Edit a saved version's title and notes
  from History.
- Compare versions using the Previous version menu or select one from the
  timeline. ArtLog uses embedded canvas previews.
- Store each file's history under its filename in `.artlog/projects/` and
  carry that history forward when ArtLog recognizes a same-folder rename.
- Permanently delete a file's saved history from Settings with a typed
  filename confirmation. The working artwork stays in place.

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
