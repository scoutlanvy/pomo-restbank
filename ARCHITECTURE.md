# Arsitektur Pomo Restbank

Aplikasi timer desktop Windows berbasis Tauri dan Rust, dengan antarmuka
TypeScript dan CSS. Mode Local memakai mesin timer di aplikasi desktop.
Mode Server memakai mesin yang sama melalui WebSocket untuk menyinkronkan
beberapa klien. Kedua mode menyimpan data melalui SQLite.

## Struktur direktori

```text
08-pomo-restbank/
├── crates/                         # Logika timer dan layanan Rust
│   ├── domain/
│   │   ├── src/lib.rs              # Aturan timer, sesi, dan saldo istirahat
│   │   └── tests/behavior.rs       # Pengujian transisi dan perhitungan timer
│   ├── protocol/
│   │   └── src/lib.rs              # Kontrak pesan JSON untuk sinkronisasi
│   ├── engine/
│   │   └── src/
│   │       ├── lib.rs              # Jam timer, transaksi SQLite, dan riwayat
│   │       ├── migration.rs        # Validasi dan impor data ke mode Local
│   │       ├── preferences.rs      # Preferensi aplikasi dan penguncian profil
│   │       └── tests.rs            # Pengujian penyimpanan, impor, dan pemulihan
│   └── server/
│       ├── src/
│       │   ├── lib.rs              # Endpoint HTTP dan sesi WebSocket
│       │   ├── main.rs             # Titik masuk proses server
│       │   └── launcher.rs         # Menyiapkan server dan menjalankan klien
│       └── tests/
│           ├── clock.rs           # Pengujian akurasi jam server
│           └── sync.rs            # Pengujian sinkronisasi dan transaksi
│
├── desktop/
│   ├── index.html                  # Titik masuk frontend
│   ├── src/
│   │   ├── main.ts                 # Koordinasi UI, aksi timer, dan Tauri IPC
│   │   ├── workspace-markup.ts     # Struktur HTML panel timer
│   │   ├── history-view.ts         # Panel riwayat, tab, dan pratinjau compact
│   │   ├── ipc-types.ts            # Tipe state, perintah, dan hasil IPC
│   │   ├── markup.ts               # Ikon dan escaping teks untuk HTML
│   │   ├── window-layout.ts        # Ukuran dan posisi jendela full/compact
│   │   └── style.css               # Tema dan layout antarmuka
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── main.rs             # IPC, backend Local/Server, tray, dan siklus aplikasi
│   │   │   ├── audio.rs            # Pemutaran tick dan alarm di Windows
│   │   │   └── instance.rs         # Koordinasi instans aplikasi
│   │   ├── assets/                 # Audio tick dan alarm
│   │   ├── icons/                  # Ikon Windows untuk aplikasi dan mode dev
│   │   ├── build.rs                # Langkah build untuk Tauri
│   │   ├── Cargo.toml              # Dependensi crate desktop
│   │   ├── tauri.conf.json         # Konfigurasi jendela dan paket desktop
│   │   └── tauri.dev.conf.json     # Konfigurasi tambahan untuk development
│   ├── ui.spec.ts                  # Pengujian UI dengan mock Tauri IPC
│   ├── playwright.config.ts        # Konfigurasi pengujian UI di Edge
│   ├── vite.config.ts              # Konfigurasi server dan build frontend
│   ├── tsconfig.json               # Konfigurasi TypeScript
│   ├── package.json                # Dependensi dan perintah desktop
│   └── package-lock.json           # Versi dependensi frontend terkunci
│
├── scripts/
│   ├── dev.mjs                     # Menjalankan aplikasi dev dengan data terisolasi
│   ├── dev-version.mjs             # Menentukan versi aplikasi development
│   ├── build.mjs                   # Membuat paket rilis Windows
│   ├── release-paths*.mjs          # Penentuan dan pengujian lokasi artefak
│   ├── release-version*.mjs        # Penentuan dan pengujian versi rilis
│   ├── native-smoke.mjs            # Smoke test desktop dengan backend Server
│   ├── local-native-smoke.mjs      # Smoke test desktop dengan backend Local
│   ├── launcher-smoke.mjs          # Smoke test launcher Windows
│   └── benchmark.mjs               # Pengukuran performa
│
├── Cargo.toml                      # Anggota dan dependensi workspace Rust
├── Cargo.lock                      # Versi dependensi Rust terkunci
├── package.json                    # Skrip npm run dev dari root proyek
├── AGENTS.md                       # Panduan perubahan kode
├── README.md                       # Panduan fitur dan penggunaan
├── README.id.md                    # Panduan pengguna dalam bahasa Indonesia
├── DEVELOPMENT.md                  # Setup, build, dan pengujian
├── PROJECT_OVERVIEW.md             # Detail alur runtime dan aturan aplikasi
├── VALIDATION.md                   # Catatan verifikasi
└── ARCHITECTURE.md                 # Peta kode dan tanggung jawab modul
```

Pembagian tanggung jawab runtime, aturan timer, dan protokol sinkronisasi
dijelaskan di [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md). Perintah untuk
menjalankan aplikasi dan tes ada di [DEVELOPMENT.md](DEVELOPMENT.md).
