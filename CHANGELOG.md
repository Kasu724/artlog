# ArtLog releases

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
PSD fixture. Photoshop itself was not available on the Windows test host.
