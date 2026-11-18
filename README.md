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

1. Open a project folder and select the Clip Studio Paint files you want to track.
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

## Backup and recovery

Projects from earlier builds can still open and browse their full history.
Earlier snapshots of other file types remain available through **Restore as
copy**. New snapshots capture tracked `.clip` files.

Copy the entire project folder, including **`.artlog/`**, while ArtLog and
the art app are closed. The SQLite index in your local application data can
be rebuilt from that folder. Settings includes a health check for stored
history. ArtLog never prunes history automatically. Large saves need room for
a staged copy and any new chunks; compression or broad project rewrites can
reduce deduplication. Open the project again to catch stable saves made while
ArtLog was closed.

If an in-place restore is interrupted, the app pauses capture and names the
recovery folder under `.artlog/staging/`. Close the art app, then inspect
`recovery.json` there. It records the target, safety checkpoint, and the
temporary folder that may contain the displaced original. Restore the safety
checkpoint as a separate copy or copy out `previous.bin` if present. Once you
have verified the working file and retained any needed versions, close ArtLog
and **move** the reported journal folder to a backup location outside
`.artlog/staging/` to resume capture. Keep the journal and recovery files
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
supports repository format 1 and refuses unsupported format versions without
migrating them. ArtLog is independent of CELSYS.

ArtLog is licensed under the [MIT License](LICENSE). Desktop packages include
third-party notices and links to exact versions of bundled dependencies.
