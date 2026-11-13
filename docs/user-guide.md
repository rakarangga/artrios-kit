# Artrios kit: user guide

**English** | [Bahasa Indonesia](#panduan-pengguna)

## 1. Install

Requirements: Python 3.9+, git, Node.js 20+ with npm (for the UI), and one model (the `claude` CLI signed in with your own account, or an API key for an OpenAI-compatible endpoint).

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.1/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.1/install.ps1 | iex
```

The wizard clones the kit to `~/artrios-kit`, checks the machine, sets up a provider, installs core and skills, builds the UI, asks you to choose the administrator password, then asks whether to start the UI with the device (section 4). Run it again any time: `python install.py --wizard`. It keeps what is already set and never installs `claude` or `codex` for you.

Manual install and a headless server: see the README.

## 2. Use

1. Open the address the wizard prints (`http://127.0.0.1:<port>/`; the port is the first free one from 4317, saved in the UI's `data/config.json`, and the address is also written to `~/.artrios/service.log`). Sign in as `administrator`.
2. Providers and keys are changed in the UI under Settings. Keys live in `~/.artrios/.env`, never in the kit folder.
3. In any Claude Code session, run `/onboard` once (7 questions). Then use skills by typing `/name` (see the skill table in the README).
4. Register a project folder with `/link-me` inside it. End a working session with `/compact-project <name>`.

## 3. Start, stop, restart

The UI and the scheduler run as one background service. From the kit folder:

```bash
python install.py --service start      # start in the background
python install.py --service status     # running or stopped, and autostart state
python install.py --service restart    # stop, then start
python install.py --service stop       # clean stop: the scheduler ends its jobs first
python install.py --service remove     # stop and switch autostart off; the UI folder and data stay
```

For a foreground run (Ctrl+C stops both): `cd apps/artrios-ui && npm start`.

Where things are: the process id is in `~/.artrios/service.json`, the output (including the address) in `~/.artrios/service.log`. If `stop` does not finish within 10 seconds, the process tree is ended. If the port is in use, set another `port` in the UI's `data/config.json`.

## 4. Start with the device (autostart)

```bash
python install.py --autostart on       # off | status
```

It runs `--service start` once at your login, with no password stored:

| System | How | Notes |
|---|---|---|
| Windows | A hidden launcher in your Startup folder | No admin rights. Runs only while you are signed in. |
| Linux | A systemd user unit `artrios-kit.service` | Starts at login. To start at boot without a login, run once: `loginctl enable-linger $USER` |
| macOS | LaunchAgent `~/Library/LaunchAgents/com.artrios.kit.plist` | Starts at login. |

Limit of this version: **Windows without a signed-in user is not supported.** If the PC restarts and nobody logs in, the UI does not start. Linux and macOS were written to the same design but have not yet been tested on a real machine; report problems.

## 5. Update

Releases are git tags `kit-vX.Y.Z`. When a newer tag exists, the UI header shows an **Update vX.Y.Z** button (it needs the release that introduced it; older installs update by hand once). It opens a decision with the changes; choose **Update** and the kit switches to the tag, rebuilds the UI, and restarts the service. Your own files are backed up to `~/.artrios/backup/` and put back, and a failed update returns to the previous version. The result shows at the top of the UI; details are in `~/.artrios/update.log`. Commits on `main` after the last tag show only as "N unreleased commits"; they arrive with the next tag.

The same from a terminal: `python install.py --update kit-vX.Y.Z`. By hand, three steps:

```bash
python install.py --service stop
cd artrios-kit && git fetch --tags && git checkout kit-vX.Y.Z
python install.py --apply        # skills, core import, and the UI rebuild when its version changed
python install.py --service start
```

`--apply` updates skills and the core import, and rebuilds the UI in `apps/artrios-ui` (npm install and build) when its version changed. No wizard step is needed. Your password, port and UI data are kept. If the background service is running, `--apply` stops it for the rebuild and starts it again.

A skill folder that exists with different content is reported as `SKIP`; remove it from `~/.claude/skills` and `~/.codex/skills` and run again. Your own files (`profile.md`, `registry.md`, `inbox.md`, `activity.md`) change by use; keep a copy before switching tags.

## 6. Remove

```bash
python install.py --service remove
python install.py --uninstall --apply   # without --apply it only shows the plan
```

Uninstall removes skills identical to the kit's copy and the core import, and asks before removing `.env`. The kit folder and your profile stay.

---

# Panduan pengguna

[English](#artrios-kit-user-guide) | **Bahasa Indonesia**

## 1. Pasang

Kebutuhan: Python 3.9+, git, Node.js 20+ dengan npm (untuk UI), dan satu model (CLI `claude` yang sudah login dengan akun Anda sendiri, atau API key endpoint OpenAI-compatible).

macOS dan Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.1/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.1/install.ps1 | iex
```

Wizard mengklon kit ke `~/artrios-kit`, mengecek mesin, menyiapkan provider, memasang inti dan skill, membangun UI, meminta Anda memilih password administrator, lalu bertanya apakah UI dijalankan otomatis bersama perangkat (bagian 4). Jalankan lagi kapan saja: `python install.py --wizard`. Yang sudah terisi tetap dipakai, dan wizard tidak memasang `claude` atau `codex` untuk Anda.

Pasang manual dan server tanpa layar: lihat README.

## 2. Pakai

1. Buka alamat yang ditampilkan wizard (`http://127.0.0.1:<port>/`; port-nya yang pertama bebas mulai 4317, tersimpan di `data/config.json` milik UI, dan alamatnya juga ditulis ke `~/.artrios/service.log`). Masuk sebagai `administrator`.
2. Provider dan key diubah di UI lewat Settings. Key ada di `~/.artrios/.env`, tidak pernah di folder kit.
3. Di sesi Claude Code mana pun, jalankan `/onboard` sekali (7 pertanyaan). Lalu pakai skill dengan mengetik `/nama` (tabel skill ada di README).
4. Daftarkan folder proyek dengan `/link-me` di dalam folder itu. Tutup sesi kerja dengan `/compact-project <nama>`.

## 3. Mulai, hentikan, mulai ulang

UI dan scheduler berjalan sebagai satu service di latar belakang. Dari folder kit:

```bash
python install.py --service start      # mulai di latar belakang
python install.py --service status     # jalan atau berhenti, plus status autostart
python install.py --service restart    # hentikan, lalu mulai
python install.py --service stop       # berhenti bersih: scheduler menyelesaikan job-nya dulu
python install.py --service remove     # hentikan dan matikan autostart; folder UI dan data tetap
```

Untuk jalan di depan (Ctrl+C menghentikan keduanya): `cd apps/artrios-ui && npm start`.

Lokasi: id proses di `~/.artrios/service.json`, keluaran (termasuk alamat) di `~/.artrios/service.log`. Bila `stop` tidak selesai dalam 10 detik, pohon prosesnya dihentikan paksa. Bila port terpakai, isi `port` lain di `data/config.json` milik UI.

## 4. Jalan bersama perangkat (autostart)

```bash
python install.py --autostart on       # off | status
```

Perintah ini menjalankan `--service start` sekali saat Anda login, tanpa menyimpan password:

| Sistem | Cara | Catatan |
|---|---|---|
| Windows | Peluncur tersembunyi di folder Startup Anda | Tanpa hak admin. Hanya jalan selama Anda login. |
| Linux | Unit systemd user `artrios-kit.service` | Mulai saat login. Agar mulai saat boot tanpa login, jalankan sekali: `loginctl enable-linger $USER` |
| macOS | LaunchAgent `~/Library/LaunchAgents/com.artrios.kit.plist` | Mulai saat login. |

Batas versi ini: **Windows tanpa pengguna yang login tidak didukung.** Bila PC restart dan tidak ada yang login, UI tidak jalan. Linux dan macOS ditulis dengan rancangan yang sama tetapi belum diuji di mesin nyata; laporkan bila ada masalah.

## 5. Update

Rilis berupa tag git `kit-vX.Y.Z`. Saat ada tag lebih baru, header UI menampilkan tombol **Update vX.Y.Z** (butuh rilis yang memuat tombol ini; instalasi lama cukup update manual sekali). Tombol membuka keputusan berisi perubahan; pilih **Update** dan kit pindah ke tag, UI dibangun ulang, layanan dinyalakan lagi. Berkas Anda dicadangkan ke `~/.artrios/backup/` lalu dikembalikan, dan update yang gagal kembali ke versi sebelumnya. Hasilnya tampil di bagian atas UI; rincian ada di `~/.artrios/update.log`. Commit di `main` setelah tag terakhir hanya tampil sebagai "N commit belum dirilis"; baru sampai pada tag berikutnya.

Sama dari terminal: `python install.py --update kit-vX.Y.Z`. Manual, tiga langkah:

```bash
python install.py --service stop
cd artrios-kit && git fetch --tags && git checkout kit-vX.Y.Z
python install.py --apply        # skill, impor inti, dan bangun ulang UI bila versinya berubah
python install.py --service start
```

`--apply` memperbarui skill dan impor inti, lalu membangun ulang UI di `apps/artrios-ui` (npm install dan build) bila versinya berubah. Langkah wizard tidak diperlukan. Password, port, dan data UI tetap. Jika layanan latar sedang berjalan, `--apply` menghentikannya untuk pembangunan ulang lalu menyalakannya lagi.

Folder skill yang sudah ada dengan isi berbeda dilaporkan `SKIP`; hapus dari `~/.claude/skills` dan `~/.codex/skills`, lalu jalankan lagi. Berkas Anda sendiri (`profile.md`, `registry.md`, `inbox.md`, `activity.md`) berubah karena pemakaian; simpan salinan sebelum berpindah tag.

## 6. Copot

```bash
python install.py --service remove
python install.py --uninstall --apply   # tanpa --apply hanya menampilkan rencana
```

Uninstall menghapus skill yang sama persis dengan salinan kit dan impor inti, dan bertanya dulu sebelum menghapus `.env`. Folder kit dan profil tetap ada.
