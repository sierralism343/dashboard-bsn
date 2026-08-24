# Panduan Setup Dashboard (Versi 1 — Login Dulu)

Ini versi PERTAMA dari dashboard, baru punya fitur:
- Login pakai akun Discord
- Lihat daftar server yang kamu punya akses admin
- Tombol "Kelola" (halaman pengaturan detailnya masih placeholder, akan ditambah bertahap)

Tujuannya: kita pastikan dulu fondasi login-nya jalan lancar, baru nanti nambah fitur pengaturan beneran.

---

## BAGIAN 1 — Siapkan di Discord Developer Portal

1. Buka https://discord.com/developers/applications, pilih aplikasi **Badan Statistik Nasional**.
2. Klik menu **OAuth2** di sidebar.
3. Kalau belum punya Client Secret, klik **Reset Secret**, copy nilainya (simpan baik-baik, jangan dishare).
4. Di bagian **Redirects**, klik **Add Redirect**, isi dengan URL dashboard kamu nanti + `/callback`. Contoh kalau nanti dashboard-nya online di `https://dashboard-bsn.up.railway.app`, maka isi:
   ```
   https://dashboard-bsn.up.railway.app/callback
   ```
   (Kalau belum tau URL final-nya, isi dulu placeholder apa aja, nanti diedit lagi setelah dashboard online dan tau alamatnya.)
5. Klik **Save Changes**.

## BAGIAN 2 — Siapkan Database di Railway

1. Buka project Railway kamu (yang isinya bot voicetrckBSN).
2. Di canvas project, klik kanan area kosong, cari opsi **Add PostgreSQL** (atau lewat tombol "+ New" di pojok).
3. Setelah database dibuat, klik service PostgreSQL itu, buka tab **Variables**, cari nilai **DATABASE_URL** — copy nanti dipakai di Bagian 4.

## BAGIAN 3 — Upload Kode Dashboard ke GitHub

1. Bikin repository GitHub baru (boleh public/private), misal namanya `dashboard-bsn`.
2. Upload semua file dashboard ini ke repo itu (server.js, package.json, .env.example).

## BAGIAN 4 — Deploy ke Railway

1. Di project Railway yang sama (satu project dengan bot), klik "+ New" > **GitHub Repo**, pilih repo `dashboard-bsn` yang baru dibuat.
2. Setelah service-nya muncul, klik, buka tab **Variables**, isi:
   ```
   DISCORD_CLIENT_ID=(Application ID dari Developer Portal)
   DISCORD_CLIENT_SECRET=(Client Secret dari Bagian 1)
   DISCORD_BOT_TOKEN=(token bot yang sama persis dengan yang dipakai bot voice tracker)
   DISCORD_CALLBACK_URL=(isi setelah tau domain Railway, lihat langkah berikut)
   SESSION_SECRET=(ketik teks acak apa aja, minimal 20 karakter, contoh: bsn-dashboard-rahasia-2026)
   DATABASE_URL=(paste dari Bagian 2)
   ```
3. Railway otomatis kasih domain publik (cek tab **Settings** > **Networking** > **Generate Domain** kalau belum ada). Copy domain itu, contoh: `dashboard-bsn-production.up.railway.app`.
4. Balik ke Variables, update `DISCORD_CALLBACK_URL` jadi:
   ```
   https://dashboard-bsn-production.up.railway.app/callback
   ```
5. Balik lagi ke Developer Portal > OAuth2 > Redirects, update juga URL Redirect-nya biar SAMA PERSIS dengan yang di atas.
6. Railway otomatis redeploy. Tunggu sampai Active.

## BAGIAN 5 — Coba Login

1. Buka domain dashboard kamu di browser (`https://dashboard-bsn-production.up.railway.app`).
2. Klik **Login dengan Discord**, approve izinnya.
3. Kalau berhasil, kamu bakal diarahkan ke halaman dashboard yang nampilin daftar server yang kamu punya akses admin, plus status apakah bot udah ada di situ atau belum.

## Troubleshooting

- **"Invalid OAuth2 redirect_uri"** → URL di Variables Railway (`DISCORD_CALLBACK_URL`) dan di Developer Portal (Redirects) harus SAMA PERSIS, termasuk `https://` dan tidak ada garis miring `/` nyasar di akhir.
- **Login berhasil tapi server list kosong** → kamu perlu punya izin Administrator di server tersebut (bukan cuma Manage Server biasa).
- **Server muncul tapi tulisannya "Bot belum diinvite"** → wajar, tandanya bot memang belum ada di situ. Invite dulu bot-nya seperti biasa lewat OAuth2 URL Generator.
