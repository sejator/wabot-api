# Dokumentasi Alur WebSocket untuk Scan QR Code WhatsApp

## 1. connect — client terhubung ke server

- Halaman Scan QR di buka otomatis memicu event `connect`.

---

## 2. session.create (emit dari client) — minta backend buat session baru

- Tujuan: meminta server membuat session baru untuk device.
- Payload (format): JSON dengan properti:
  - key: string — device key unik
  - name: string — nama perangkat/session
  - engine: string — engine/driver yang digunakan (mis. "baileys")

Payload contoh (copy-paste):

```json
{
  "key": "device123",
  "name": "My Device",
  "engine": "baileys"
}
```

Catatan:

- Server akan membuat instance session (mis. Baileys), menyimpan kredensial di memori/berkas.
- Setelah dibuat, client akan otomatis bergabung ke room sesuai `key` (deviceKey).

---

## 3. session.created (emit dari server) — konfirmasi session berhasil dibuat

- Dikirim oleh server sebagai konfirmasi pembuatan session.

Payload contoh:

```json
{
  "key": "device123",
  "message": "Session created"
}
```

---

## 4. session.qr (emit dari server) — backend kirim QR code

- Dikirim ketika server menghasilkan QR code untuk login WhatsApp.
- Payload:
  - key: string — device key
  - qr: string — data URI gambar PNG base64 (atau plain base64)
  - timeout: number — waktu kedaluwarsa QR dalam detik

Payload contoh (copy-paste):

```json
{
  "key": "device123",
  "qr": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "timeout": 300
}
```

Tips:

- Tampilkan `qr` langsung di elemen <img src="..."> atau decode base64 untuk ditampilkan.
- Gunakan `timeout` untuk menampilkan countdown atau men-trigger refresh QR.

---

## 5. session.ready (emit dari server) — device sudah terkoneksi ke WhatsApp

- Menandakan device sudah tersambung dan siap menerima/perintah.

Payload contoh:

```json
{
  "key": "device123"
}
```

---

## 6. session.authenticated (emit dari server) — session sudah autentik

- Menandakan proses autentikasi berhasil (kredensial tersimpan).

Payload contoh:

```json
{
  "key": "device123"
}
```

---

## 7. session.disconnected (emit dari server) — device terputus atau QR code expired

- Dikirim saat koneksi terputus atau sesi logout/QR expired.

Payload contoh:

```json
{
  "key": "device123",
  "reason": "user logged out"
}
```

Contoh alasan lain: `"qr expired"`, `"connection lost"`, `"session revoked"`.

---

## Contoh alur singkat (urutan event)

1. Client terhubung → server memicu `connect`.
2. Client emit `session.create` dengan payload pembuatan session.
3. Server emit `session.created`.
4. Server emit `session.qr` (tampilkan QR ke user).
5. Setelah scan → server emit `session.authenticated` dan/atau `session.ready`.
6. Jika terputus atau gagal → server emit `session.disconnected`.

---

## Catatan implementasi singkat

- Gunakan room/namespace berdasarkan `key` supaya pesan hanya diterima client pemilik device.
- Pastikan handling timeout untuk QR dan pembersihan sesi yang tidak terpakai.
- Simpan kredensial secara aman (filesystem terenkripsi atau store aman) sesuai kebutuhan.

---

Dokumentasi ini disusun agar payload JSON dapat langsung disalin dan digunakan di client/server Halaman Scan QR di buka Anda.
