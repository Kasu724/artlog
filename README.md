# ArtLog

ArtLog is a local desktop companion for Clip Studio Paint (`.clip`) projects.
It keeps exact copies of saved artwork so you can
experiment and get back to an earlier version. Artwork stays on your computer.
ArtLog needs no account, telemetry service, or network connection to work.
ArtLog does not implement artwork uploads or analytics. On Windows,
[Microsoft's WebView2 runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/data-privacy)
may make its own network requests and report diagnostics according to
Windows settings. Offline operation does not imply that the OS runtime
has no outbound traffic when the device is connected.

## Use ArtLog

1. Choose **Open a .clip file** to track one document where it is, or **Open a
   project folder** and select the related documents you want on a shared
   timeline. A file and folder project can track the same artwork independently.
2. Keep editing in Clip Studio Paint. ArtLog captures stable saves on the **main**
   timeline and skips identical automatic snapshots. Use **New checkpoint** to
   name a milestone and add a note. Change tracking and save delay in Settings.
3. Select a version and file to inspect, compare, or restore. **Restore as copy**
   is the default. It checks the restored bytes and refuses to overwrite an
   existing file. To replace a working file, close it in Clip Studio Paint, confirm
   the named target, and let ArtLog record its safety snapshot first.

ArtLog automatically reads the embedded canvas preview from each saved
`.clip` version and shows a thumbnail in History. Existing versions generate
their thumbnails when viewed. For checkpoints containing several files,
History shows the first available `.clip` preview.
You can also attach a PNG or JPEG export, which takes priority over the
embedded preview. Use **Restore as copy** to open and export an older version
whose embedded preview is unavailable. Previews are flattened, scaled to at most
1,024 pixels on the long edge, and may not match editor color management.
Two available previews can be panned and zoomed together. Matching dimensions
allow overlay and pixel difference. All versions remain exactly restorable
when previews are missing.

## Manage tracked files and history

- In **Files** or **Settings**, use **Stop tracking** to stop capturing future
  saves and keep earlier versions. Select the file again in Settings to resume
  tracking. If you move or rename a working file, reopen its project and choose
  **Link renamed file** to keep its history under the same identity.
- Use **View file history** to see checkpoints and thumbnails for one file.
  **Show project timeline** brings back the shared view.
- **Delete file history** archives the pre-delete project, stops tracking the
  selected file, and rewrites the active timeline without its saved versions.
  The rewrite can change checkpoint IDs. **Remove project** in Settings sends
  that project's history and settings to ArtLog trash. Both actions leave
  working artwork in place.
- Open **ArtLog trash** from Settings or browse it by folder from the welcome
  screen. **Restore from trash** recovers the archived project. If the active
  project has changed since a file deletion, recovery creates a separate
  project. **Permanently delete** erases the selected archive after a separate
  typed confirmation. ArtLog keeps trash until you restore or permanently
  delete it.

## Backup and recovery

ArtLog upgrades earlier folder projects on open. It stages and verifies the new
layout before retiring the old metadata, preserving checkpoint IDs and source
artwork. Reopen the location to resume an interrupted upgrade or history move.
If an upgrade needs attention, ArtLog can open readable history for restoring
copies while capture is paused. Earlier snapshots of other file types remain
available through **Restore as copy**.

Copy the entire project folder, including **`.artlog/`**, while ArtLog and
the art app are closed. Each project has its own directory under
`.artlog/projects/`, with per-file records and preview caches under `files/`.
Content objects are reused across files and versions within that project.
`.artlog/trash/` travels with the folder too. The SQLite index in your local
application data can be rebuilt from the portable history. Settings includes
a health check. An upgrade, history rewrite, or trash restore needs room for
staged history. Open a project again to catch stable saves made while ArtLog
was closed.

If an in-place restore is interrupted, the app pauses capture and names the
recovery folder under the project's `staging/` directory. Close the art app,
then inspect `recovery.json` there. It records the target, safety checkpoint, and the
temporary folder that may contain the displaced original. Restore the safety
checkpoint as a separate copy or copy out `previous.bin` if present. Once you
have verified the working file and retained any needed versions, close ArtLog
and **move** the reported journal folder to a backup location outside
`staging/` to resume capture. Keep the journal and recovery files
together until you no longer need them.

## Development

Install Node.js 22.12+ (Node 22 or 24 LTS) and current stable Rust with `rustfmt`
and `clippy`.
Follow the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):
Windows needs the MSVC C++ Build Tools and WebView2; macOS needs the Xcode
Command Line Tools.

```sh
npm ci
npm run tauri dev
```

Run these checks from the repository root:

```sh
npm run check
npm run notices
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --workspace --locked
```

Build a Windows NSIS installer with `npm run tauri -- build --bundles nsis`
or a macOS disk image on macOS with `npm run tauri -- build --bundles dmg`.
Find packages under `src-tauri/target/release/bundle/`. Windows needs WebView2
already installed; the installer does not download it. Build tools fetch
dependencies, but the installed app works offline. These build commands do not
sign or notarize the app.

ArtLog targets local disks on Windows and macOS. In-place restore works one
file at a time and requires a filesystem with hard links (such as NTFS or
APFS). Use a copy for removable drives, network shares, or other filesystems.
Branches, merges, and cloud sync are outside this release. ArtLog
upgrades format 1 to the format 2 container and rejects unknown format
versions. ArtLog is independent of CELSYS.

ArtLog is licensed under the [MIT License](LICENSE). Desktop packages include
third-party notices and links to exact versions of bundled dependencies.
