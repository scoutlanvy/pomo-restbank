# Pomo Restbank

**Bangun fokus. Tabung waktu istirahat.**

Aplikasi timer Windows dengan mode Lokal bawaan dan mode Server Rust opsional. Versi ini merupakan rebuild FokusSaldo di repository baru; aplikasi Python dan data lamanya tidak dipakai atau diubah.

## Menjalankan

Butuh Windows 10/11 dan WebView2 Runtime. Untuk membangun dari source, pasang Rust MSVC, C++ Build Tools beserta Windows SDK, dan Node.js 22.12 atau lebih baru.

Jalankan dari root proyek:

```powershell
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run release
.\dist\PomoRestbank-Launcher.exe
```

Build menghasilkan aplikasi, launcher Rust, server opsional, installer NSIS, dan ZIP portable di `dist/`. Buka `pomo-restbank.exe` atau `PomoRestbank-Launcher.exe`: **mode Lokal menjadi default**, termasuk setelah memperbarui instalasi lama. Timer dan SQLite berjalan di dalam aplikasi tanpa proses server terpisah atau port jaringan. Installer yang memasang klien saja sudah cukup untuk mode Lokal; Node.js hanya diperlukan untuk build.

Build melewati executable yang identik. Jika executable berubah dan sedang dipakai, pilih **Quit** pada aplikasi yang memakai file itu sebelum build ulang; packaging tidak menghentikan proses otomatis. Server perlu dihentikan terpisah saat mengganti executable server.

### Data Lokal, impor, dan menutup aplikasi

Database Lokal berada di `%LOCALAPPDATA%\PomoRestbank\local\restbank.sqlite3`; preview memakai `preview-local`. Jika data server Pomo Restbank ada di laptop ini, pembukaan Lokal pertama menawarkan **Import existing data**, **Start fresh**, atau **Cancel and quit** sebelum membuat data Lokal. Hentikan server sumber sebelum impor. Impor membuat cadangan `server-backup-*.sqlite3` bertanggal di direktori Lokal, lalu menyalin subject, seluruh riwayat, saldo, progres, pengaturan, dan checkpoint timer. Timer yang belum selesai dibuka paused. Database server dan kredensial lama tetap dipertahankan. Impor tidak menimpa database Lokal yang sudah ada. Data Lokal dan Server berjalan terpisah sesudahnya; impor lewat jaringan dan dari aplikasi Python tidak tersedia.

Satu jendela Lokal berjalan untuk setiap direktori data normal/preview; membuka aplikasi lagi menampilkan jendela yang sudah berjalan, termasuk dari tray. Default tombol **X masuk system tray**: timer, bunyi tik, dan alarm penyelesaian tetap aktif. Menu tray menyediakan **Open** dan **Quit**. Ubah **Settings → Application → When closing the window** jika X harus keluar. Quit menyimpan checkpoint Lokal paused dan menghentikan bunyi. Waktu aplikasi berhenti tidak dihitung; alarm lama tidak diputar kembali. Jika tray gagal dibuat, jendela tetap terlihat; gunakan **Quit application** di Settings.

### Mode Server opsional

Pilih **Settings → Application → Connection mode → Server**, simpan, lalu **Quit application** dan buka lagi. Pilihan disimpan. Perpindahan mode membutuhkan tidak ada perintah pending dan timer Idle ketika terhubung. Klien Server yang terputus boleh berpindah jika tidak ada pending; ini tidak menghentikan timer remote. Dalam mode Server, launcher menyalakan server lokal dan menyiapkan koneksi profil baru jika diperlukan. Membuka klien langsung memungkinkan koneksi ke komputer server lain lewat **Your sync connection**. Pengaturan koneksi lama tetap disimpan saat memakai Lokal.

Untuk dua jendela mode Server, gunakan profil berbeda:

```powershell
.\dist\PomoRestbank-Launcher.exe --backend server --profile first
.\dist\PomoRestbank-Launcher.exe --backend server --profile second
```

Tambahkan `--preview` untuk target fokus 10 detik dan reward 5/5/5/15 detik, dengan data tersendiri. Server normal memakai port 4317, preview port 4318. Bisa juga klik dua kali `PomoRestbank-Launcher.exe`; pengguna tidak memerlukan Node.js atau skrip PowerShell. Launcher harus berada di samping executable klien; mode Server lokal juga memerlukan executable server. Installer NSIS sudah cukup untuk Lokal; ZIP portable menyertakan launcher dan server.

Menjalankan klien Server langsung juga bisa dengan `pomo-restbank.exe --backend server`. Untuk Lokal preview cukup `PomoRestbank-Launcher.exe --preview`. Klien dan server menerima `--data-dir PATH` untuk pengujian terisolasi; `--backend local|server` pada klien/launcher mengganti pilihan mode hanya untuk pemanggilan tersebut. Di Settings, masukkan alamat server dan token dari `%LOCALAPPDATA%\PomoRestbank\server\token.txt`. Token preview ada di `preview-server\token.txt`. Jaga kerahasiaan token dan `connection.json` profil klien.

## Alur penggunaan

- Pilih subject dan mode Manual atau Pomodoro. Start tidak otomatis berjalan saat aplikasi dibuka.
- Manual menyimpan sesi hanya ketika selesai. Reset membatalkan sesi Manual yang belum selesai.
- Pomodoro menargetkan fokus 25 menit. Selesai satu target memberikan saldo istirahat 5, 5, 5, lalu 15 menit secara berulang.
- Stop Alarm membuka pilihan Continue Focus atau memakai saldo; istirahat tidak dimulai otomatis.
- Reset fokus menyimpan durasi yang sudah dijalani dan mengurangi sisa target berikutnya. Contoh: fokus 10 menit, Reset, lalu target tersisa 15 menit. Selesai sisanya memberikan satu reward, tanpa pencatatan ganda.
- Saldo berkurang hanya selama istirahat berjalan. Pause dan waktu menunggu alarm tidak menghabiskan saldo. Skip Break mempertahankan saldo tersisa.
- Fokus yang dijeda bisa diselingi istirahat. Sesudahnya fokus kembali dalam keadaan paused.
- Settings menyediakan progres Shared atau Per subject, bunyi tik On/Off, dan volume tik 0–400%. Progres kedua scope tetap terpisah; saldo dan siklus reward tetap bersama.
- Subject dapat ditambah atau dihapus dari daftar. Klik kanan item subject untuk menghapus tanpa memilihnya terlebih dahulu. Umum dilindungi. Riwayat dan progres subject yang dihapus tetap disimpan.
- History menampilkan ringkasan per subject dan 30 sesi terbaru dengan waktu Asia/Jakarta. Tema terang/gelap bersifat lokal.
- Space hanya untuk Pause/Resume; input teks dan dialog tidak terganggu.

Pembaruan timer mempertahankan input yang sedang diedit, fokus keyboard, dan menu subject yang terbuka selama kontrol masih tersedia. Mode Manual memerlukan durasi positif sebelum Start. Settings mempertahankan draft saat status kontrol mengikuti kondisi timer dan koneksi terbaru. Pesan validasi bertahan sampai input diedit atau dicoba kembali. Klik di luar dialog, gunakan Cancel/Close, atau tekan Escape untuk menutupnya. Animasi singkat dialog/menu mengikuti preferensi reduced motion sistem. History yang terbuka dimuat ulang setelah reconnect. Perintah langsung mengunci kontrol tanpa meredupkan kontrol yang hanya menunggu konfirmasi. Indikator Waiting dan Retry same command muncul pada baris judul panel setelah 300 ms, sehingga perintah cepat tidak memunculkan kilatan banner atau menggeser timer. Settings memakai indikator tertunda yang sama sambil mempertahankan draft.

### Mode Ringkas

Klik **Compact mode** di header untuk beralih ke timer ringkas. Fitur ini diaktifkan secara manual; mengecilkan jendela biasa tidak mengaktifkannya. Mode Ringkas tetap menampilkan subject, mode/sesi, countdown, aksi utama, Reset, dan saldo istirahat. **Details** membuka kontrol istirahat, progres fokus, History, serta Full view di jendela yang sama. Skip break tetap terlihat ketika relevan. **Full view**, termasuk ikon perluas di atas, memulihkan ukuran, posisi, dan status maximize sebelumnya. History juga kembali ke tampilan lengkap dan membuka panel riwayat. Pengubahan mode, subject, dan durasi Manual dilakukan di tampilan lengkap; Start Manual dari Mode Ringkas memakai draft durasi saat ini.

Ukuran awal Mode Ringkas adalah 390x560 logical pixels, atau 390x740 ketika Details terbuka, dibatasi area kerja monitor. Jika ruang layar terbatas, konten dapat digulir vertikal. Tema, aturan server, bunyi, dan timer tetap sama dengan tampilan lengkap. Settings serta pesan error/retry tetap tersedia. Aplikasi selalu dibuka dalam tampilan lengkap, dan Details tertutup setiap kali masuk Mode Ringkas. Fitur selalu di atas belum disertakan.

## Sinkronisasi Server dan pemulihan

Satu server memiliki satu timer bersama. Klien yang terhubung dapat mengendalikan timer, dan seluruh klien menerima status yang sama. Perubahan bersamaan dengan status kedaluwarsa ditolak agar tidak saling menimpa.

Saat koneksi putus, kontrol dinonaktifkan dan countdown diberi tanda perkiraan. Tidak ada perubahan offline yang diam-diam digabungkan. Setelah reconnect, status server diambil kembali. Retry same command memakai ID yang sama untuk mencegah duplikasi.

Semua klien yang online saat selesai berbunyi; Stop Alarm dari satu klien menghentikan semuanya. Klien yang baru masuk tidak memutar alarm lama.

Timer tetap berjalan walaupun semua jendela ditutup, selama server masih hidup. Setelah server berhenti atau restart, timer pulih paused dari checkpoint terakhir. Waktu komputer server tidur tidak dihitung; gangguan penjadwalan di atas tiga detik menjeda timer. Kesalahan penyimpanan juga menjeda timer sampai Retry berhasil.

Server berjalan terpisah. Untuk menghentikan server yang dijalankan langsung dari terminal, gunakan Ctrl+C. Untuk server dari launcher, hentikan proses `pomo-restbank-server.exe` yang sesuai di Task Manager.

## Data dan batas versi

Data baru disimpan di `%LOCALAPPDATA%\PomoRestbank`: `local`, `preview-local`, `server`, `preview-server`, `clients\PROFIL`, dan `preview-clients\PROFIL`. Cadangkan direktori server saat server berhenti. Cache klien bukan sumber data utama.

LAN dapat diaktifkan dengan server `--listen 0.0.0.0:4317`; klien lain memakai IP LAN server dan token yang sama. Mode ini hanya untuk jaringan pribadi tepercaya, belum untuk internet publik. Android, TLS/hosting publik, penggabungan perubahan offline ke server, dan impor data Python belum termasuk versi ini.

Atur `CARGO_TARGET_DIR` ke direktori milik tugas di Temp untuk memakai ulang cache packaging terisolasi. Lokasi rilis bisa dipilih dengan `npm.cmd --prefix desktop run release -- PATH_OUTPUT_ABSOLUT`. Build fitur ini tersedia di `dist/local-mode/`.

Lihat README.md untuk perintah pengujian, PROJECT_OVERVIEW.md untuk rincian teknis, dan VALIDATION.md untuk hasil pemeriksaan aktual.
