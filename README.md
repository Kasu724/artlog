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

1. Choose **Open a .clip file** to start or reopen its history. **Recently
   opened** also reopens a file's history. Select **ArtLog** in the project
   header to return home.
2. Keep editing in Clip Studio Paint. ArtLog captures stable saves and skips
   identical snapshots. Use the pencil beside a version to edit its title and
   notes. Edits stay with that history and preserve the saved version ID.
3. Select a version to inspect, compare, or restore. Choose a comparison from
   the **Previous version** menu or click the previous preview and choose a
   version in History. **Restore as a copy** verifies the restored bytes and
   requires a new destination. To replace a working file, close it in Clip
   Studio Paint, confirm the named target, and let ArtLog record a safety
   snapshot first.

ArtLog reads the embedded canvas preview from each saved `.clip` version and
shows a thumbnail in History. Previews are flattened, scaled to at most 1,024
pixels on the long edge, and may differ from the editor's color management.
Two available previews can be panned and zoomed together. Matching dimensions
allow overlay and pixel difference. Restore remains available when a preview
is missing.

## Manage a file's history

- In **Settings**, pause or resume automatic capture and change the time ArtLog
  waits for a save to settle.
- ArtLog can recognize a same-folder rename and carry the history forward.
  If the rename is not recognized, reopen the history from **Recently opened**
  and use **Link renamed file** in Settings.
- **Delete file history** permanently removes the saved versions, previews,
  titles, notes, and settings for that file after you type its exact filename.
  ArtLog returns to the homepage and leaves the working artwork in place.
  Opening the file again starts a fresh history. If deletion is interrupted,
  reopen the location to finish the confirmed operation.

## History compression

ArtLog uses lossless Zstandard level 1 for new history objects by default. A
chunk is compressed only when its stored size, including its header, saves at
least 1% and 1 KiB. Savings vary by artwork because `.clip` can already contain
compressed data. ArtLog still deduplicates chunks by their original bytes and
verifies the original chunk and complete file during restore.

In **Settings → History storage**, turn off **Compress new content objects** to
store newly encountered chunks as raw bytes. Earlier objects remain readable and
can still be reused across versions. Use **Compress existing history** to repack
eligible objects already on disk. The result reports the measured change in
stored content-object bytes. **Portable history** shows the current logical size
of the open project's history, excluding preview files.

Before downgrading to a build without compression support, run **Convert history
to raw** in each affected project and wait for **Raw layout verified**. The
conversion turns off compression, expands its objects, and verifies the raw
layout while preserving saved versions, previews, and working artwork. Raw
conversion can need more disk space. If either operation stops, free space if
needed and run the same operation again. Keep this version of ArtLog available
until each conversion finishes successfully.

## Backup and recovery

ArtLog upgrades earlier single-file histories to filename-based directories.
Shared folder histories and trash archives from earlier releases stay on disk.
Access those histories with an earlier release that supports their storage
format.

Copy the entire project folder, including **`.artlog/`**, while ArtLog and
Clip Studio Paint are closed. Separate `.clip` projects in the same folder
share one `.artlog/` container. A file named `Cover.clip` normally stores
its history in `.artlog/projects/Cover.clip/`. ArtLog can keep a history in
its existing directory if the preferred name is occupied. Content objects are
reused across versions of the same file. The SQLite index in your local
application data can be rebuilt from the portable history. Settings includes
a health check. Open a project again to catch stable saves made while ArtLog
was closed.

If an in-place restore is interrupted, the app pauses capture and names the
recovery folder under the project's `staging/` directory. Close the art app,
then inspect `recovery.json` there. It records the target, safety snapshot, and
the temporary folder that may contain the displaced original. Restore the safety
snapshot as a separate copy or copy out `previous.bin` if present. Once you
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
upgrades older histories to the format 3 container and rejects unknown format
versions. ArtLog is independent of CELSYS.

ArtLog is licensed under the [MIT License](LICENSE). Desktop packages include
third-party notices and links to exact versions of bundled dependencies.
