# ArtLog

ArtLog is a desktop companion for keeping local version history of Clip Studio
Paint (`.clip`) and Photoshop (`.psd`) projects. Artwork stays on your
computer. The app does not require an account or a network connection.

## Development

Install Node.js 22.12+ and stable Rust with `rustfmt` and `clippy`.
Follow the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):
Windows needs the MSVC C++ Build Tools and WebView2; macOS needs the Xcode
Command Line Tools.

```sh
npm ci
npm run tauri dev
npm run tauri build
```

ArtLog targets local disks on Windows and macOS. ArtLog is independent of and
not affiliated with Adobe or CELSYS.

ArtLog is licensed under the [MIT License](LICENSE).
