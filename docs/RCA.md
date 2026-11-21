# Root Cause Analysis (RCA): Checkout Deadlock & Duplicate Credit Card Capture

- **Incident ID:** `INC-2026-1029-ERB-KUTA`
- **Timestamp:** `2026-10-29T18:32:14.218+08:00` (WITA / Asia/Makassar)
- **Severity:** SEV-1 (Financial Impact — Duplicate Charge & Broken Inventory Hold)
- **Affected Service:** `CheckoutWorker` / Booking Checkout API
- **Affected Payload:**
  ```json
  {
    "booking_id": "erb_kuta_9941",
    "vehicle_id": "car_avanza_04",
    "customer_id": "cust_foreign_881"
  }
  ```
- **Error Signature:**
  ```text
  [2026-10-29T18:32:14.218+08:00] ERROR [CheckoutWorker] TransactionRollbackError: deadlock detected. Process 9182 waits for ExclusiveLock on relation 'vehicle_reservations'; blocked by process 9188.
  ```

---

## 1. Executive Summary

Pada tanggal 29 Oktober 2026 pukul 18:32 WITA, sebuah **kiosk retry storm** di lokasi Kuta mengirimkan beberapa request checkout secara simultan untuk payload yang sama (`booking_id: erb_kuta_9941`, `vehicle_id: car_avanza_04`, `customer_id: cust_foreign_881`).

Kombinasi dari **(1) tidak adanya idempotency key deduplication**, **(2) pola lock upgrade / table-level `ExclusiveLock` pada PostgreSQL (`vehicle_reservations`)**, dan **(3) eksekusi external payment capture di dalam/sebelum transaksi database ter-commit tanpa gateway idempotency key** memicu `deadlock detected` (PostgreSQL SQLSTATE `40P01`) antara backend process `9182` dan `9188`.

Akibatnya, PostgreSQL melakukan `ROLLBACK` terhadap transaksi reservasi kendaraan, sementara request HTTP ke Payment Gateway yang sudah terlanjur terkirim dari beberapa worker tetap berhasil mengeksekusi **credit card capture secara berulang (duplicate capture)**—meninggalkan customer `cust_foreign_881` ter-charge berkali-kali **tanpa confirmed vehicle hold** untuk `car_avanza_04`.

---

## 2. Deep-Dive Technical Analysis

### 2.1 Mengapa Kiosk Retry Storm Menyebabkan PostgreSQL Deadlock (`ExclusiveLock`)

Perhatikan detail spesifik pada error log PostgreSQL:

> `Process 9182 waits for ExclusiveLock on relation 'vehicle_reservations'; blocked by process 9188.`

Di PostgreSQL, operasi DML biasa (`INSERT`, `UPDATE`, `DELETE`) hanya mengambil `RowExclusiveLock` pada level relasi (tabel), yang **saling kompatibel** antar transaksi paralel. Kemunculan **`ExclusiveLock` pada relation `'vehicle_reservations'`** menunjukkan adanya **lock upgrade deadlock** akibat penggunaan coarse-grained table lock (`LOCK TABLE vehicle_reservations IN EXCLUSIVE MODE`) atau eskalasi lock setelah transaksi sudah memegang lock yang lebih lemah (`AccessShareLock` / `RowExclusiveLock`).

#### Mekanisme terjadinya Deadlock saat Kiosk Retry Storm:
1. **Trigger (Kiosk Retry Storm):** Kiosk Kuta mengalami latency spike / packet loss atau customer menekan tombol *Pay / Confirm* berkali-kali karena UI tidak di-debounce. Kiosk melakukan aggressive retry otomatis tanpa *exponential backoff*, tanpa *jitter*, dan tanpa `Idempotency-Key`. Beberapa request identik untuk `erb_kuta_9941` masuk ke `CheckoutWorker` dalam rentang milidetik yang sama dan ditangani secara paralel oleh PostgreSQL backend **PID 9182** dan **PID 9188** (serta worker retry lainnya).
2. **Phase 1 — Shared Lock Acquisition (`AccessShareLock`):**
   - PID `9182` membuka transaksi (`BEGIN`) dan menjalankan `SELECT ... FROM vehicle_reservations WHERE vehicle_id = 'car_avanza_04'` untuk mengecek ketersediaan unit. PostgreSQL memberikan **`AccessShareLock`** pada tabel `vehicle_reservations` kepada PID `9182`.
   - Hampir bersamaan, PID `9188` membuka transaksi (`BEGIN`) dan menjalankan query `SELECT` yang sama. Karena `AccessShareLock` kompatibel dengan `AccessShareLock`, PID `9188` juga langsung mendapatkan **`AccessShareLock`** pada `vehicle_reservations`.
3. **Phase 2 — Lock Upgrade Collision (`AccessShareLock` → `ExclusiveLock`):**
   - Kedua transaksi mencoba melakukan serialisasi penulisan dengan meminta **`ExclusiveLock`** pada relasi `vehicle_reservations` (untuk mencegah *double booking* sebelum melakukan `INSERT`/`UPDATE`).
   - Dalam matriks konflik lock PostgreSQL, **`ExclusiveLock` berkonflik dengan `AccessShareLock`** (dan `RowExclusiveLock`).
   - **PID 9182** meminta `ExclusiveLock` → **terblokir** karena PID `9188` masih memegang `AccessShareLock`.
   - **PID 9188** meminta `ExclusiveLock` → **terblokir** karena PID `9182` masih memegang `AccessShareLock`.
4. **Phase 3 — Circular Wait & Abort (`40P01`):**
   - Terbentuk siklus ketergantungan (*circular wait*: `9182 → 9188 → 9182`).
   - Setelah melewati `deadlock_timeout` (default PostgreSQL `1000ms`), deadlock detector PostgreSQL aktif, membatalkan transaksi PID `9182` dengan error `40P01: deadlock detected`, dan membangkitkan `TransactionRollbackError` di `CheckoutWorker`.
   - Pada retry storm dengan 3–5+ concurrent worker, PID `9188` pun berisiko tinggi langsung terlibat deadlock berikutnya dengan PID retry lain (mis. `9191`), atau gagal akibat timeout/constraint violation—menyebabkan **seluruh** transaksi DB berakhir `ROLLBACK`.

### 2.2 Mengapa Terjadi Duplicate Credit Card Capture Tanpa Confirmed Vehicle Hold

Error `TransactionRollbackError` hanya membatalkan perubahan di dalam PostgreSQL (**local ACID boundary**), tetapi **tidak dapat membatalkan side-effect eksternal** (HTTP API call ke Payment Gateway).

```mermaid
sequenceDiagram
    autonumber
    participant Kiosk as Kuta Kiosk (Retry Storm)
    participant W1 as CheckoutWorker #1 (PG PID 9182)
    participant W2 as CheckoutWorker #2 (PG PID 9188)
    participant PG as PostgreSQL (vehicle_reservations)
    participant PSP as Payment Gateway (No Idempotency)

    Kiosk->>W1: POST /checkout (erb_kuta_9941, car_avanza_04)
    Kiosk->>W2: Retry #1 POST /checkout (erb_kuta_9941, car_avanza_04)

    W1->>PG: BEGIN; SELECT ... FROM vehicle_reservations (AccessShareLock)
    W2->>PG: BEGIN; SELECT ... FROM vehicle_reservations (AccessShareLock)

    Note over W1,PSP: Anti-pattern: External Payment Capture dilakukan<br/>sebelum hold ter-commit & tanpa Idempotency-Key!
    W1->>PSP: POST /v1/charges/capture (cust_foreign_881)
    W2->>PSP: POST /v1/charges/capture (cust_foreign_881)
    PSP-->>W1: 200 OK (Capture #1 SUCCEEDED)
    PSP-->>W2: 200 OK (Capture #2 SUCCEEDED - DUPLICATE!)

    W1->>PG: LOCK TABLE vehicle_reservations IN EXCLUSIVE MODE
    Note right of PG: PID 9182 waits for ExclusiveLock<br/>blocked by PID 9188 (AccessShareLock)
    W2->>PG: LOCK TABLE vehicle_reservations IN EXCLUSIVE MODE
    Note right of PG: PID 9188 waits for ExclusiveLock<br/>blocked by PID 9182 (AccessShareLock)

    PG-->>W1: ERROR 40P01: deadlock detected (ROLLBACK)
    W1-->>Kiosk: 500 Internal Server Error (triggers more retries!)

    Note over W2,PG: PID 9188 gagal/rollback oleh retry storm berikutnya<br/>atau timeout koneksi kiosk
    PG-->>W2: ROLLBACK (No reservation persisted)

    Note over Kiosk,PSP: HASIL AKHIR: Kartu cust_foreign_881 ter-capture 2x+,<br/>tetapi car_avanza_04 memiliki 0 confirmed hold!
```

Empat cacat arsitektural yang menyebabkan fenomena ini:

1. **External I/O Inside / Before DB Commit (Dual-Write Hazard):**
   `CheckoutWorker` mengeksekusi capture kartu kredit ke Payment Gateway *sebelum* vehicle hold berhasil di-commit (atau di tengah transaksi DB yang masih terbuka). Ketika PostgreSQL melakukan `ROLLBACK` akibat deadlock, uang sudah ter-capture tetapi baris `vehicle_reservations` hilang.
2. **Absennya End-to-End Idempotency Key:**
   - API Checkout tidak mewajibkan & menduplikasi `Idempotency-Key` per intent booking.
   - Payment Gateway request tidak menyertakan deterministic `Idempotency-Key` (mis. berbasis `booking_id` / `checkout_idempotency_key`), sehingga setiap worker paralel dianggap sebagai transaksi kartu kredit baru oleh acquiring bank.
3. **Tidak Ada Distributed / Atomic Pre-Locking (Fail-Fast):**
   Request paralel yang menargetkan `vehicle_id: car_avanza_04` tidak disaring oleh atomic lock non-blocking sebelum menyentuh database maupun payment gateway. Semuanya menembus langsung ke lapisan DB dan PSP secara bersamaan.
4. **Uncaught 500 Error Memicu Retry Loop Lebih Parah:**
   Alih-alih mengembalikan `409 Conflict` yang jelas dan non-blind-retryable, `TransactionRollbackError` dikembalikan sebagai `500 Internal Server Error`, memicu kiosk retry otomatis berulang-ulang dan memperparah duplicate capture.

---

## 3. Contributing Factors Summary

| Layer | Root / Contributing Factor | Dampak Langsung |
| :--- | :--- | :--- |
| **Client (Kuta Kiosk)** | Aggressive retry tanpa exponential backoff, jitter, dan debounce tombol pembayaran | Membanjiri API dengan request identik dalam hitungan milidetik |
| **API / Application** | Tidak ada strict `Idempotency-Key` deduplication (`IN_PROGRESS` / `COMPLETED` state) | Setiap retry diproses sebagai checkout baru |
| **Concurrency Control** | Tidak ada fail-fast atomic lock pada `vehicle_id`; memakai coarse-grained `ExclusiveLock` upgrade di DB | Circular wait antara PID 9182 & 9188 → `40P01 deadlock_detected` |
| **Payment Integration** | Credit card capture dipanggil tanpa confirmed/persisted vehicle hold & tanpa PSP idempotency key | Duplicate capture kartu kredit `cust_foreign_881` tanpa reservasi aktif |
| **Error Handling** | Deadlock/contention dikembalikan sebagai `500` alih-alih graceful `409 Conflict` | Kiosk terus mengulang request sehingga memperbesar *blast radius* |

---

## 4. Immediate Remediation & API Patch

Patch darurat diimplementasikan pada [src/patch/checkout_handler.ts](../src/patch/checkout_handler.ts) (diverifikasi melalui [src/patch/test_concurrency.ts](../src/patch/test_concurrency.ts)) dengan empat kontrol utama:

1. **Strict Idempotency Key Deduplication (Atomic Claim):**
   - Setiap request checkout wajib menyertakan `Idempotency-Key` beserta *request fingerprint* (SHA-256 dari `booking_id`, `vehicle_id`, `customer_id`).
   - Claim atomik (`IN_PROGRESS`) mencegah dua request dengan key sama berjalan bersamaan; request kedua langsung ditolak graceful dengan **`409 Conflict` (`IDEMPOTENCY_IN_PROGRESS`)**.
   - Jika request sebelumnya sudah `COMPLETED`, request ulang mengembalikan response cache (`idempotentReplay: true`) tanpa memanggil Payment Gateway lagi.
   - Jika key yang sama dipakai untuk payload berbeda, ditolak dengan **`409 Conflict` (`IDEMPOTENCY_PAYLOAD_MISMATCH`)**.

2. **Non-Blocking Atomic Distributed Locking (`vehicle_id`):**
   - Sebelum membaca/menulis reservasi atau memanggil Payment Gateway, worker wajib memperoleh **atomic non-blocking lock** pada `lock:vehicle:{vehicle_id}` (setara Redis `SET key token NX PX ttl` atau PostgreSQL `pg_try_advisory_xact_lock`).
   - Karena sifatnya **fail-fast (no waiting)**, kondisi *circular wait* tidak pernah terbentuk → **eliminasi deadlock 100%**.
   - Request konkuren yang gagal memperoleh lock langsung mendapatkan **`409 Conflict` (`VEHICLE_LOCK_CONFLICT`)** secara graceful dengan header `Retry-After`.

3. **Reserve-Before-Capture Ordering (No Capture Without Hold):**
   - Urutan eksekusi dikunci secara ketat:
     1. Acquire atomic lock untuk `vehicle_id` (fail-fast).
     2. Verifikasi availability & buat **`PENDING` vehicle hold** di database/store terlebih dahulu.
     3. Eksekusi **Payment Gateway Capture** dengan deterministic `gatewayIdempotencyKey` (`capture:{booking_id}:{idempotency_key}`).
     4. Jika capture sukses → transisi hold menjadi **`CONFIRMED`** dan simpan hasil idempotency (`COMPLETED`).
     5. Jika capture gagal → lakukan kompensasi dengan melepaskan hold (`RELEASED`), bersihkan state in-progress, dan release lock.

4. **Incident Financial Reconciliation (Operational Action):**
   - Audit seluruh charge di Payment Gateway untuk `cust_foreign_881` / `erb_kuta_9941` pada window `2026-10-29T18:30–18:40+08:00`.
   - Void / refund seluruh duplicate capture dan konfirmasi manual status unit `car_avanza_04` dengan cabang Kuta.

---

## 5. Long-Term Architectural Prevention

1. **Database-Level Invariant (PostgreSQL):**
   - Hapus total penggunaan `LOCK TABLE ... IN EXCLUSIVE MODE`.
   - Gunakan `SELECT ... FROM vehicles WHERE id = $1 FOR UPDATE NOWAIT` (fail-fast pada level baris tunggal) dan **PostgreSQL Exclusion Constraint** (`EXCLUDE USING gist (vehicle_id WITH =, reservation_range WITH &&) WHERE (status IN ('PENDING', 'CONFIRMED'))`) serta `UNIQUE (booking_id)` agar database secara fisik menolak double-booking tanpa table lock.
2. **Distributed Lock Production Backend:**
   - Ganti `InMemoryAtomicLockManager` dengan Redis (`SET key token NX PX ttl` + Lua compare-and-delete script + fencing tokens) agar konsisten lintas multiple worker pods.
3. **Two-Phase Payment Authorization & Outbox Pattern:**
   - Pisahkan **Payment Authorization (Hold dana)** dari **Capture**: lakukan *Authorize* terlebih dahulu, commit `CONFIRMED` vehicle hold di PostgreSQL bersama event di *Transactional Outbox*, lalu jalankan *Capture* secara asinkron & idempoten (atau *Void* otomatis jika hold gagal).
4. **Kiosk Client Hardening:**
   - Generate UUID `Idempotency-Key` satu kali saat tombol *Pay* ditekan, disable UI button selama in-flight, terapkan *exponential backoff with jitter* hanya untuk error `5xx`/network timeout (bukan `409 Conflict`), dan gunakan status polling `GET /bookings/{booking_id}` setelah timeout.
