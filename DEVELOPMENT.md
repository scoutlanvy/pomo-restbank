# Development Pomo Restbank

## Setup

Prasyarat: Windows 10/11, WebView2, Node.js >=22.12, Rust MSVC, C++ Build Tools + Windows SDK, dan Edge untuk tes UI. Jalankan dari root repository lewat PowerShell:

```powershell
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run dev
```

**Pomo Restbank [DEV]** mendukung hot reload frontend dan kompilasi ulang Rust. Data, pengaturan, dan cache build terisolasi di `%TEMP%/pomo-restbank-dev-<hash-repository>/` (lokasi dicetak di terminal), sehingga aplikasi utama boleh tetap berjalan. Data dev bertahan hingga Temp dibersihkan.

Berhenti: **Quit** di tray/Settings, lalu Ctrl+C di terminal. Tombol X secara default hanya menyembunyikan jendela.

## Perintah utama

| Perintah | Fungsi |
|---|---|
| `npm.cmd --prefix desktop run dev:frontend` | Vite saja; timer native tidak berjalan di browser |
| `npm.cmd --prefix desktop run build` | Pemeriksaan TypeScript dan build frontend |
| `npm.cmd --prefix desktop test` | Tes UI dengan mock Tauri IPC |
| `npm.cmd --prefix desktop run release` | Paket aplikasi ke `dist/`; perlu tag versi pada HEAD |

Pemanggilan langsung `run tauri -- dev` melewati isolasi dan dapat memakai data utama.
e-smoke.mjs --build-dir PATH_TO_BUILD_OUTPUT.

Jika port 1420 sedang dipakai, tes UI dapat memakai port lain tanpa menghentikan aplikasi development:

```powershell
$env:POMO_UI_TEST_PORT = '1432'
npm.cmd --prefix desktop test
```
