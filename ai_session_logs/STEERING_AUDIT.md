# AI Session Steering & Technical Audit Log

> **Project:** Easy Rent Bali — Track C (*The Kuta Sunset Outage*)  
> **Purpose:** Mendokumentasikan intervensi korektif (*human-in-the-loop engineering steering*) di mana reviewer/engineer mengidentifikasi celah reliabilitas produksi pada draf awal generasi AI dan mengarahkan arsitektur/kode menuju implementasi yang aman di lingkungan operasional nyata.

---

## Ringkasan Intervensi

| Instance | Fase / Area | Celah pada Generasi Awal AI | Risiko Produksi | Arah Koreksi Engineer | Bukti Implementasi |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **#1** | **Part 1 — Network Failover** | Static `/32` route pinning untuk `1.1.1.1` & `8.8.8.8` di tabel `main` pada WAN1 + *global conntrack flush* saat failover | **DNS Blackout total** saat failover ke WAN2 + pemutusan paksa stream CCTV/NVR lokal & printer POS | Pisahkan IP probe non-DHCP (`1.0.0.1`, `9.9.9.9`, `203.0.113.10`) ke tabel routing PBR terisolasi (`probe_wan1`/`probe_wan2`) + *scoped conntrack flush* khusus NAT egress WAN1 | [`docs/NETWORK_ARCHITECTURE.md`](../docs/NETWORK_ARCHITECTURE.md) (§3.2, §3.4, §3.5, §4) |
| **#2** | **Part 2 — Concurrency & Idempotency** | `fencingToken` tidak divalidasi menyeluruh dengan `409 STALE_FENCING_TOKEN` di `ReservationStore` (`createPendingHold` & `confirmHold`) + risiko `Idempotency-Key` nyangkut di `IN_PROGRESS` / gagal dibersihkan saat 502 atau *unhandled exception* | *Stale write* menimpa reservasi valid saat jitter `> 400ms` / lease expiry + kiosk gagal retry setelah transient `502` | Validasi monotonic `incomingToken < lastAcceptedToken` (`409 STALE_FENCING_TOKEN`) di `createPendingHold` & `confirmHold` + unified `try/catch/finally` dengan `claimToken` untuk selalu melepas key saat 5xx/exception | [`src/patch/checkout_handler.ts`](../src/patch/checkout_handler.ts), [`src/patch/test_concurrency.ts`](../src/patch/test_concurrency.ts) |

---

## Instance #1 — Part 1: Network Failover (`docs/NETWORK_ARCHITECTURE.md`)

### 1. Masalah pada Draf Awal AI
Pada iterasi pertama desain Dual-WAN Failover `< 3 detik` untuk Kuta Hub, AI menghasilkan dua *anti-pattern* jaringan yang sering luput di atas kertas tetapi fatal di produksi:
1. **DNS Blackhole akibat Static `/32` Route Pinning pada `1.1.1.1` & `8.8.8.8` di WAN1:**
   - AI mem-pin target SLA health-check `1.1.1.1/32` dan `8.8.8.8/32` ke gateway WAN1 langsung pada tabel routing `main`, padahal IP DNS yang sama (`1.1.1.1` & `8.8.8.8`) juga dibagikan ke klien VLAN 20 (POS/Kiosk), VLAN 30 (Staff), dan VLAN 50 (Guest) melalui DHCP.
   - **Dampak jika dibiarkan:** Begitu WAN1 *down* dan *default route* berpindah ke WAN2 Cellular, seluruh kueri DNS klien tetap cocok dengan *longest-prefix match* `/32` yang mengarah ke WAN1 yang mati → terjadi **DNS Blackout total** meskipun internet WAN2 sebenarnya hidup.
2. **Global Conntrack Flush saat Event Failover (`WAN1 → WAN2`):**
   - Script failover awal menjalankan *global connection tracking flush* untuk membersihkan sesi TCP WAN1 yang macet (*stalled*).
   - **Dampak jika dibiarkan:** Global flush turut membunuh seluruh sesi lokal non-NAT yang sehat di dalam Kuta Hub—termasuk *live stream* RTSP Front-Desk Manager menuju **Local NVR (`10.10.40.10`)**, aliran IP CCTV → NVR, sesi cetak POS → Thermal Printer (TCP `9100`), serta sesi manajemen internal.

### 2. Koreksi & Arah Steering Engineer
Saya menghentikan penggunaan konfigurasi tersebut dan mengarahkan dua perubahan desain defensif:
1. **Dedicated Non-DHCP Probe IPs + Isolated PBR Routing Tables (`probe_wan1` & `probe_wan2`):**
   - Membiarkan klien DHCP memakai `1.1.1.1` dan `8.8.8.8` sepenuhnya melalui *default route* tabel `main` (nol rute `/32` probe di tabel `main`), sehingga DNS otomatis berpindah ke WAN2 saat failover.
   - Memindahkan target SLA probe WAN1 ke IP khusus non-DHCP (`1.0.0.1`, `9.9.9.9`, dan endpoint HQ Renon `203.0.113.10`) dan WAN2 ke (`8.8.4.4`, `203.0.113.20`), dengan *policy-based routing* (`chain=output` mangle `routing-mark=probe_wan1` / `probe_wan2`) dan *fallback blackhole* `distance=250` agar probe tidak bocor ke WAN lain.
2. **Scoped Conntrack Flush Khusus NAT Egress WAN1:**
   - Mengganti global flush dengan filter spesifik hanya untuk koneksi yang mengalami SNAT ke IP publik WAN1:
     - **RouterOS v7:** `/ip firewall connection remove [find where srcnat=yes && reply-dst-address~("^" . $wan1Ip . "(:|\$)")]`
     - **Linux / NFTables:** `conntrack -D --reply-dst <WAN1_PUBLIC_IP>`
     - **FortiGate:** `diagnose sys session filter dintf wan1` + `diagnose sys session clear`
   - Menambahkan Acceptance Criteria Uji #6 (*Zero DNS Blackout saat Failover*) dan Uji #7 (*Kontinuitas Sesi LAN/NVR 0% putus*).

### 3. Hasil Setelah Koreksi
Arsitektur pada [`docs/NETWORK_ARCHITECTURE.md`](../docs/NETWORK_ARCHITECTURE.md) kini bebas dari risiko DNS blackhole dan mempertahankan kontinuitas penuh trafik lokal LAN/CCTV/NVR maupun POS printer selama transisi failover `< 3 detik`.

---

## Instance #2 — Part 2: Concurrency & Idempotency (`src/patch/checkout_handler.ts` & `test_concurrency.ts`)

### 1. Masalah pada Draf Awal AI
Setelah review kode hasil generasi awal pada [`src/patch/checkout_handler.ts`](../src/patch/checkout_handler.ts) dan [`src/patch/test_concurrency.ts`](../src/patch/test_concurrency.ts), ditemukan dua celah reliabilitas kritis untuk kondisi jaringan Kuta yang mengalami *brownout* (**jitter > 400 ms** dan **18% packet loss**):
1. **Monotonic `fencingToken` Tidak Divalidasi Penuh oleh `ReservationStore`:**
   - `InMemoryAtomicLockManager` sudah menghasilkan `fencingToken` monotonik, tetapi pada `InMemoryReservationRepository`:
     - `createPendingHold` melempar kode generik `VEHICLE_ALREADY_RESERVED` alih-alih kode eksplisit `STALE_FENCING_TOKEN`.
     - `confirmHold` **tidak memeriksa `incomingToken < lastAcceptedToken`** terhadap `lastAcceptedTokenByVehicle` (hanya membandingkan `existing.fencingToken !== fencingToken` dan tidak memeriksa status `PENDING`).
   - **Dampak jika dibiarkan:** Ketika Worker A mengalami stall/jitter `> 400 ms` atau *GC pause* selama pemanggilan Payment Gateway hingga lease lock-nya kedaluwarsa, lalu Worker B memperoleh token lebih baru (`token=2`) dan menulis ke store, Worker A yang terbangun membawa `token=1` masih dapat memanggil `confirmHold` dan menimbulkan *stale write* / inkonsistensi reservasi.
2. **Risiko `Idempotency-Key` Nyangkut di `IN_PROGRESS` atau Salah Penanganan pada Transient `502` / Unhandled Exception:**
   - Pemanggilan `lockManager.tryAcquire(...)` berada di luar blok `try / finally`, sehingga *unhandled exception* dari backend lock langsung meninggalkan `Idempotency-Key` terkunci di status `IN_PROGRESS` hingga TTL habis.
   - Di dalam blok `catch`, pemanggilan `reservationRepo.releaseHold(...)` berjalan sebelum `idempotencyStore.release(idempotencyKey)` tanpa isolasi error—jika kompensasi DB melempar exception, key kembali nyangkut di `IN_PROGRESS`.
   - Selain itu, *unhandled exception* non-gateway tertangkap dan disamarkan menjadi `502 PAYMENT_CAPTURE_FAILED`, dan tidak ada verifikasi eksplisit pada test bahwa entry di `InMemoryIdempotencyStore` benar-benar dihapus (tidak nyangkut `IN_PROGRESS` dan tidak di-cache permanen sebagai `502`).

### 2. Koreksi & Arah Steering Engineer
Saya mengarahkan dua perbaikan spesifik beserta skenario verifikasi otomatisnya:
1. **Penegakan Monotonic Fencing Token (`409 STALE_FENCING_TOKEN`):**
   - Menambahkan error code `STALE_FENCING_TOKEN` di `CheckoutErrorCode` dan `ReservationConflictError`.
   - Menerapkan `assertFreshFencingToken(vehicleId, incomingToken)` di **kedua** operasi mutasi `InMemoryReservationRepository`: `createPendingHold` dan `confirmHold` (menolak jika `incomingToken < lastAcceptedToken`, sekaligus memvalidasi kecocokan token & status `PENDING` pada `confirmHold`).
   - Memetakan `STALE_FENCING_TOKEN` di `CheckoutHandler` menjadi HTTP `409` (`retryable: true`) lengkap dengan metadata `incoming_fencing_token` dan `last_accepted_fencing_token`.
2. **Guaranteed Idempotency Cleanup pada Transient `502` & Unhandled Exception:**
   - Menyatukan seluruh alur pasca-`tryClaim` ke dalam satu blok `try / catch / finally` dengan kepemilikan berbasis `claimToken`.
   - Memisahkan transient error Payment Gateway ke `PaymentGatewayError` → HTTP `502 PAYMENT_CAPTURE_FAILED` (tidak pernah disimpan lewat `idempotencyStore.complete`), mengisolasi error kompensasi `releaseHold`, dan melempar ulang *unhandled exception* setelah `finally` mengeksekusi `idempotencyStore.release(idempotencyKey, claimToken)` dan `lockManager.release(lease)`.
   - Menambahkan helper `getStatus()` / `has()` pada `InMemoryIdempotencyStore` untuk observabilitas pengujian.

### 3. Hasil & Bukti Verifikasi
Ditambahkan pengujian terfokus di [`src/patch/test_concurrency.ts`](../src/patch/test_concurrency.ts):
- **Test 3 (diperketat):** Verifikasi setelah `502 PAYMENT_CAPTURE_FAILED`, `idempotencyStore.getStatus(key) === null` & `has(key) === false`, retry langsung dengan `Idempotency-Key` sama sukses `201`, dan replay berikutnya `200`.
- **Test 4 (baru):** Verifikasi *unhandled exception* pada `lockManager.tryAcquire`, `reservationRepo.createPendingHold`, dan kegagalan kompensasi `releaseHold` tetap membersihkan `Idempotency-Key` & lock sehingga retry sukses `201`.
- **Test 5 (baru):** Verifikasi penolakan stale write (`incomingToken < lastAcceptedToken`) dengan HTTP `409 STALE_FENCING_TOKEN` pada `createPendingHold`, `confirmHold` (simulasi lease expiry saat payment capture), dan pengecekan langsung `InMemoryReservationRepository`.

Seluruh verifikasi lulus penuh (`npm run typecheck` dan `npm run test:concurrency` — **5/5 test suite PASS**).
