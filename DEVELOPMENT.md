# Development Pomo Restbank

Jalankan perintah dari root repository melalui PowerShell.

## Setup dan dev

Butuh Windows 10/11, WebView2, Node.js >=22.12, Rust MSVC, serta C++ Build Tools dengan Windows SDK. Tes UI memakai Microsoft Edge.

```powershell
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run dev
```

Aplikasi **Pomo Restbank [DEV]** mendukung hot reload frontend dan kompilasi ulang Rust. Data, pengaturan, dan cache build terpisah di `%TEMP%/pomo-restbank-dev-<hash-repository>/`; aplikasi utama boleh tetap berjalan. Lokasinya dicetak di terminal. Data dev bertahan antar-run, tetapi dapat hilang saat Temp dibersihkan.

Gunakan **Quit** di tray/Settings, lalu Ctrl+C di terminal untuk berhenti. Tombol X secara default hanya menyembunyikan jendela.

## Perintah utama

| Perintah | Fungsi |
|---|---|
| `npm.cmd --prefix desktop run dev` | Desktop dev dengan data terisolasi |
| `npm.cmd --prefix desktop run dev:frontend` | Vite saja; timer native tidak berjalan di browser |
| `npm.cmd --prefix desktop run build` | Pemeriksaan TypeScript dan build frontend |
| `npm.cmd --prefix desktop test` | Tes UI dengan mock Tauri IPC |
| `npm.cmd --prefix desktop run release` | Paket aplikasi ke `dist/`; perlu tag versi pada HEAD |

Pemanggilan langsung `run tauri -- dev` melewati isolasi dan dapat memakai data utama.

## Pemeriksaan sebelum merge

Jalankan berurutan; pastikan setiap perintah berhasil:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP ('pomo-restbank-check-' + [guid]::NewGuid().ToString('N'))
npm.cmd --prefix desktop run build
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

Untuk perubahan UI, jalankan juga `npm.cmd --prefix desktop test`. Kosongkan port 1420 dari Vite lain sebelum tes.

Smoke test native memakai output build yang sesuai, membuka jendela sementara, dan memainkan alarm pendek:

```powershell
node scripts/native-smoke.mjs --build-dir PATH_TO_BUILD_OUTPUT
node scripts/local-native-smoke.mjs --build-dir PATH_TO_BUILD_OUTPUT
```

## Referensi dan aturan

- [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md): struktur kode, arsitektur, dan aturan timer.
- [AGENTS.md](AGENTS.md): aturan kontribusi dan keamanan data. Gunakan database tes terisolasi di Temp; jangan membuka database legacy atau data pengguna untuk tes.
- [VALIDATION.md](VALIDATION.md): hasil pengujian dan keterbatasan.
- [README.md](README.md) / [README.id.md](README.id.md): instalasi, penggunaan, dan rilis.

Perbarui dokumentasi yang terdampak bersama kode di branch fitur; selaraskan kedua README jika instalasi atau penggunaan berubah.
