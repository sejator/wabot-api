# 🤖 Wabot API

Wabot API adalah layanan WhatsApp Notification Gateway berbasis NestJS yang mendukung beberapa engine WhatsApp—Baileys, WPPConnect, dan whatsapp-web.js—sehingga memungkinkan pengiriman pesan, manajemen sesi multi-device, notifikasi realtime melalui WebSocket, dan webhook ke aplikasi eksternal.

Ringkasnya, proyek ini dirancang untuk menjadi API WhatsApp serbaguna dan modular yang mudah diintegrasikan ke sistem bisnis atau produk SaaS.

---

## Daftar Isi

- [Fitur Utama](#-fitur-utama)
- [Arsitektur Singkat](#-arsitektur-singkat)
- [Struktur Direktori](#-struktur-direktori)
- [Instalasi & Persiapan](#-instalasi--persiapan)
  - [1. Clone Repository](#1-clone-repository)
  - [2. Instal PostgreSQL & Redis (host)](#2-instal-postgresql--redis-host)
  - [3. Konfigurasi .env](#3-konfigurasi-env)
  - [4. Instal Dependensi](#4-instal-dependensi)
  - [5. Migrasi Database](#5-migrasi-database)
  - [6. Menjalankan Aplikasi](#6-menjalankan-aplikasi)
- [Penggunaan & Fitur](#penggunaan--fitur)
- [Lisensi & Atribusi](#-lisensi--atribusi)
- [Penggunaan Komersial & Catatan](#-penggunaan-komersial--catatan)
- [Kontributor & Kontak](#-kontributor--kontak)

---

## 🚀 Fitur Utama

- Multi-Engine Support: Baileys, WPPConnect, dan WWebJS (whatsapp-web.js).
- Realtime WebSocket: Pantau status sesi dan pesan masuk secara langsung.
- Queue & Retry System: Menggunakan Redis dan worker untuk pengiriman pesan dengan mekanisme retry.
- Manajemen Sesi: Penyimpanan sesi otomatis (Prisma DB untuk Baileys; file system untuk WWebJS/WPPConnect).
- Arsitektur Modular (NestJS): Mudah diperluas dan di-maintain.
- File Logger: Log harian otomatis di folder `logs/`.
- Webhook Worker: Menangani notifikasi outbound ke sistem eksternal.

---

## 🏗️ Arsitektur Singkat

```ts
┌──────────────────────────────┐
│          Wabot API           │
│──────────────────────────────│
│ ┌──────────────────────────┐ │
│ │      Engine Manager      │ │
│ │ (Baileys / WPP / WWebJS) │ │
│ └──────────────────────────┘ │
│             ↓                │
│     Prisma DB / Redis Queue  │
│             ↓                │
│     WebSocket / Webhook      │
└──────────────────────────────┘
```

Setiap engine diimplementasikan melalui abstraksi (mis. `AbstractEngine`) sehingga engine dapat diganti tanpa mengubah logika bisnis utama.

---

## 📁 Struktur Direktori (ringkasan)

```
src/
├── common/                  # Modul umum (logger, utils, filters, interceptors)
│   ├── interfaces/engines   # Engine WhatsApp (Baileys, WPPConnect, WWebJS)
│   ├── interfaces/message   # Struktur pesan per platform
│   └── logger/              # File logger & cleanup
│
├── modules/
│   ├── sessions/            # Manajemen sesi WhatsApp
│   ├── messages/            # Endpoint untuk kirim pesan
│   ├── webhook/             # Worker & service webhook
│   └── redis/               # Modul Redis
│
├── prisma/                  # Service ORM Prisma (skema & client)
└── main.ts                  # Entry point aplikasi
```

---

## ⚙️ Cara Install

### 1. Clone repository

```bash
git clone https://github.com/sejator/wabot-api.git
cd wabot-api
```

### 2. Instal PostgreSQL & Redis (di host)

Postgres digunakan untuk penyimpanan data sesi & log. Redis digunakan untuk queue & retry.

- Windows
  - Instal PostgreSQL: https://www.postgresql.org/download/windows/
    - Setelah instalasi, buat database:

    ```bash
    psql -U postgres
    CREATE DATABASE wabot_api;
    \q
    ```

  - Instal Redis (Memurai): https://www.memurai.com/download
    - Jalankan service Memurai, lalu cek:

    ```bash
    redis-cli ping
    ```

- Linux (Ubuntu/Debian)
  - PostgreSQL:

    ```bash
    sudo apt update
    sudo apt install postgresql postgresql-contrib -y
    sudo systemctl enable --now postgresql
    sudo -u postgres psql
    CREATE DATABASE wabot_api;
    \q
    ```

  - Redis:

    ```bash
    sudo apt install redis-server -y
    sudo systemctl enable --now redis-server
    redis-cli ping
    ```

> Catatan: Untuk lingkungan produksi, pertimbangkan menggunakan managed services atau containerized deployments.

### 3. Konfigurasi .env

Salin contoh dan sesuaikan:

```bash
cp .env.example .env
```

Contoh isi .env (ringkasan penting):

```env
# App
APP_URL=http://localhost:3000
PORT=3000
NODE_ENV=production

# Postgres / Prisma
DATABASE_USER=postgres
DATABASE_PASSWORD=yourpassword
DATABASE_NAME=wabot_api
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_URL="postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}?schema=public"

# Redis
REDIS_PASSWORD=
REDIS_PORT=6379
REDIS_URL=redis://:${REDIS_PASSWORD}@localhost:${REDIS_PORT}

# Baileys & WWebJS
DELAY_RESTART=10
QRCODE_TERMINAL=false
QRCODE_TIME_OUT=60
QRCODE_MAX_RETRY=1

# WWebJS spesifik
WWEBJS_PUPPETEER_HEADLESS=true
WWEBJS_SESSION_PATH=/path/to/project/wabot-api/.wabot_auth
WWEBJS_CACHE_PATH=/path/to/project/wabot-api/.wwebjs_cache

# Encryption key (32 bytes base64 recommended)
AUTH_STATE_ENCRYPTION_KEY=xxx-32-bytes-base64-encoded-key-xxx

# Dashboard Admin
PUBLIC_KEY_SERVER_ADMIN=
PRIVATE_KEY_SERVER_ADMIN=
SERVER_IP_ADMIN=
WEBHOOK_URL_ADMIN=
```

Pastikan `AUTH_STATE_ENCRYPTION_KEY` memiliki panjang & format sesuai yang diharapkan.

Di bawah ini contoh konfigurasi .env jika Anda ingin membuat dashboard.  
Isi `PUBLIC_KEY_SERVER_ADMIN` dan `PRIVATE_KEY_SERVER_ADMIN` persis sama dengan yang terdaftar di dashboard. Untuk `SERVER_IP_ADMIN` masukkan IP server yang diizinkan (pisahkan beberapa IP dengan koma). Untuk `WEBHOOK_URL_ADMIN` isi dengan domain atau URL endpoint dashboard admin. Jika nilai tersebut belum tersedia atau tidak digunakan, biarkan kosong.

### Dashboard Admin

```bash
# ==================================================
# Dashboard Admin Credentials
# ==================================================
PUBLIC_KEY_SERVER_ADMIN=xxx
PRIVATE_KEY_SERVER_ADMIN=xxx
SERVER_IP_ADMIN="127.0.0.1,::1"
WEBHOOK_URL_ADMIN=http://localhost:8000/api/webhook/device
```

### 4. Instal dependensi

```bash
npm install
```

### 5. Migrasi database (Prisma)

```bash
npx prisma migrate dev
npx prisma generate
```

Untuk production gunakan `prisma migrate deploy` sesuai kebutuhan environment.

### 6. Menjalankan aplikasi

- Dengan Docker Compose (jika tersedia):

```bash
docker compose up -d
```

- Manual (NPM):

```bash
npm run build
npm run start:prod
```

---

## 🔧 Penggunaan & Integrasi

- Endpoints REST untuk mengirim pesan (teks, gambar, video, dokumen).
- WebSocket untuk event realtime (session status, pesan masuk).
- Worker & Redis queue untuk pengiriman pesan dan retry.
- Pilih engine melalui konfigurasi (Baileys / WPPConnect / WWebJS). Setiap engine memiliki path penyimpanan sesi masing-masing (Prisma DB untuk Baileys; file system untuk WWebJS/WPPConnect).

Lihat dokumentasi API (jika tersedia di repo) atau sumber kode modul `modules/messages` dan `modules/sessions` untuk detail endpoint dan payload.

---

## 🔐 Lisensi & Atribusi

Proyek ini memanfaatkan beberapa library open-source:

- WPPConnect — GNU LGPL v3.0
- whatsapp-web.js (WWebJS) — Apache-2.0
- Baileys — MIT

Disclaimer: Proyek ini tidak berafiliasi dengan WhatsApp / Meta Platforms, Inc. Gunakan sesuai hukum dan kebijakan WhatsApp: https://www.whatsapp.com/legal/terms-of-service

---

## 💼 Penggunaan Komersial & Catatan

Wabot API dapat digunakan untuk:

- Otomatisasi notifikasi pelanggan (transaksi, OTP, pengingat).
- Integrasi dengan POS, CRM, ERP, atau sistem internal.
- Menjadi basis gateway WhatsApp unofficial (perhatikan risiko).

PENTING:

- Jangan klaim sebagai “API WhatsApp Resmi”.
- Gunakan nomor bisnis terpisah untuk mengurangi risiko pemblokiran.
- Patuhi kebijakan & rate limit pihak ketiga.

---

## 🤝 Kontributor & Kontak

Maintainer: [@sejator](https://github.com/sejator)  
Email: sejatordev@gmail.com  
Website: https://alkhatech.com

Jika ingin berdonasi untuk mendukung pengembangan proyek ini, bisa melalui:  
[https://saweria.co/sejator](https://saweria.co/sejator)

---

Terima kasih telah menggunakan Wabot API — semoga membantu mempercepat integrasi WhatsApp Anda!
