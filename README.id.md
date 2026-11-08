# Pomo Restbank

**Bangun fokus. Tabung waktu istirahat.**

Aplikasi timer Windows dengan server sinkronisasi Rust. Versi ini merupakan rebuild FokusSaldo di repository baru; aplikasi Python dan data lamanya tidak dipakai atau diubah.

## Menjalankan

Butuh Windows 10/11 dan WebView2 Runtime. Untuk membangun dari source, pasang Rust MSVC, C++ Build Tools beserta Windows SDK, dan Node.js 22.12 atau lebih baru.

Jalankan dari root proyek:

```powershell
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run release
.\dist\PomoRestbank-Launcher.exe
```

Build melewati penyalinan executable klien/server jika isinya identik, sehingga server aktif yang tidak berubah tidak menghalangi packaging. Jika executable berubah dan sedang dipakai, tutup proses yang memakai file tersebut lalu ulangi build; skrip tidak menghentikan proses secara otomatis.

Launcher menjalankan server lokal jika belum aktif, menyiapkan koneksi untuk profil baru, lalu membuka aplikasi. Menutup jendela tidak menghentikan server maupun timer yang sedang berjalan.

Untuk dua jendela, gunakan profil berbeda:

```powershell
.\dist\PomoRestbank-Launcher.exe --profile first
.\dist\PomoRestbank-Launcher.exe --profile second
```

Tambahkan `--preview` untuk target fokus 10 detik dan reward 5/5/5/15 detik, dengan data tersendiri. Server normal memakai port 4317, preview port 4318. Bisa juga klik dua kali `PomoRestbank-Launcher.exe`; pengguna tidak memerlukan Node.js atau skrip PowerShell. Launcher harus berada di samping executable klien dan server. Installer NSIS hanya memasang klien; gunakan ZIP portable untuk launcher dan server.

Menjalankan executable secara langsung juga bisa. Di Settings, masukkan alamat server dan token dari `%LOCALAPPDATA%\PomoRestbank\server\token.txt`. Token preview ada di `preview-server\token.txt`. Jaga kerahasiaan token dan `connection.json` profil klien.

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

## Sinkronisasi dan pemulihan

Satu server memiliki satu timer bersama. Klien yang terhubung dapat mengendalikan timer, dan seluruh klien menerima status yang sama. Perubahan bersamaan dengan status kedaluwarsa ditolak agar tidak saling menimpa.

Saat koneksi putus, kontrol dinonaktifkan dan countdown diberi tanda perkiraan. Tidak ada perubahan offline yang diam-diam digabungkan. Setelah reconnect, status server diambil kembali. Retry same command memakai ID yang sama untuk mencegah duplikasi.

Semua klien yang online saat selesai berbunyi; Stop Alarm dari satu klien menghentikan semuanya. Klien yang baru masuk tidak memutar alarm lama.

Timer tetap berjalan walaupun semua jendela ditutup, selama server masih hidup. Setelah server berhenti atau restart, timer pulih paused dari checkpoint terakhir. Waktu komputer server tidur tidak dihitung; gangguan penjadwalan di atas tiga detik menjeda timer. Kesalahan penyimpanan juga menjeda timer sampai Retry berhasil.

Server berjalan terpisah. Untuk menghentikan server yang dijalankan langsung dari terminal, gunakan Ctrl+C. Untuk server dari launcher, hentikan proses `pomo-restbank-server.exe` yang sesuai di Task Manager.

## Data dan batas versi

Data baru disimpan di `%LOCALAPPDATA%\PomoRestbank`: `server`, `preview-server`, `clients\PROFIL`, dan `preview-clients\PROFIL`. Cadangkan direktori server saat server berhenti. Cache klien bukan sumber data utama.

LAN dapat diaktifkan dengan server `--listen 0.0.0.0:4317`; klien lain memakai IP LAN server dan token yang sama. Mode ini hanya untuk jaringan pribadi tepercaya, belum untuk internet publik. Android, TLS/hosting publik, kontrol offline, dan impor data Python belum termasuk versi ini.

Lihat README.md untuk perintah pengujian, PROJECT_OVERVIEW.md untuk rincian teknis, dan VALIDATION.md untuk hasil pemeriksaan aktual.
