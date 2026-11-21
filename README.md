# Easy Rent Bali — Track C: *The Kuta Sunset Outage*

Solusi terintegrasi lintas jaringan, backend concurrency/idempotency, dan real-time fleet self-healing engine untuk menangani insiden **"The Kuta Sunset Outage"** (degradasi brownout WAN1 Fiber dengan **jitter > 400 ms** dan **18% packet loss** pada jam sibuk sore–malam di Kuta Hub).

---

## Ringkasan Arsitektur (Track C)

| Fase / Part | Fokus Utama | Solusi Kunci | Artefak |
| :--- | :--- | :--- | :--- |
| **Part 1 — Network Architecture & Resilience** | Segmentasi VLAN & Dual-WAN Brownout Failover (`< 3 detik`) | 802.1Q 5-VLAN Matrix (Mgmt, POS/Kiosk DSCP EF, Staff, Fleet IoT/CCTV *zero public ingress*, Guest Wi-Fi terisolasi), SLA Sliding-Window Failover (`250 ms` × 10 probe, quorum `>= 2/3`), PBR probe table terisolasi (`probe_wan1`/`probe_wan2`, anti-DNS blackout), *scoped WAN1-NAT-only conntrack flush* (aman untuk LAN/NVR), anti-flapping hysteresis + hold-down (`180s/300s/900s`), dan auto-throttle VLAN 50 `< 128 kbps` saat mode WAN2 Cellular Survival. | [`docs/NETWORK_ARCHITECTURE.md`](./docs/NETWORK_ARCHITECTURE.md) |
| **Part 2 — Concurrency Triage & Idempotent Checkout Patch** | Eliminasi PostgreSQL Deadlock (`40P01`) & Duplicate Credit Card Capture | Root Cause Analysis insiden `INC-2026-1029-ERB-KUTA` + patch TypeScript dengan fail-fast atomic locking + monotonic `fencingToken` (`409 STALE_FENCING_TOKEN` pada `createPendingHold` & `confirmHold`), strict `Idempotency-Key` deduplication dengan pembersihan otomatis pada `502` / *unhandled exception*, serta urutan *Reserve-Before-Capture*. | [`docs/RCA.md`](./docs/RCA.md), [`src/patch/checkout_handler.ts`](./src/patch/checkout_handler.ts), [`src/patch/test_concurrency.ts`](./src/patch/test_concurrency.ts) |
| **Part 3 — Real-Time Fleet & Network Self-Healing Engine** | Triase Telemetri Multi-Flag & Self-Healing Alert Dispatch | Engine triase membaca `data/outage_telemetry.json` dan menandai multi-flag (`CRITICAL_SECURITY_ALERT`, `OFFLINE_TELEMETRY_DROP`, `MAINTENANCE_REQUIRED`), lalu mengirimkan payload alert terstruktur via **Exponential Backoff + Full Jitter** menghadapi simulasi **18% packet loss** dan mengekspor laporan rekonsiliasi lengkap ke JSON. | [`data/outage_telemetry.json`](./data/outage_telemetry.json), [`src/engine/triage_engine.ts`](./src/engine/triage_engine.ts), [`src/engine/dispatcher.ts`](./src/engine/dispatcher.ts), [`output/incident_reconciliation.json`](./output/incident_reconciliation.json) |
| **Part 4 — Audit & Steering Log** | Transparansi Human-in-the-Loop Engineering | Dokumentasi konkret intervensi koreksi engineer terhadap celah generasi AI pada Part 1 (DNS blackhole & global conntrack flush) dan Part 2 (`STALE_FENCING_TOKEN` & pembersihan `Idempotency-Key` pada error 5xx/exception). | [`ai_session_logs/STEERING_AUDIT.md`](./ai_session_logs/STEERING_AUDIT.md) |

---

## Struktur Direktori

```text
easy-rent-bali-assessment/
├── README.md                                 # Panduan ringkas & cara eksekusi reviewer
├── package.json                              # Dependencies & npm scripts (typecheck, test:concurrency, engine:run)
├── tsconfig.json                             # Konfigurasi TypeScript strict (NodeNext ESM)
├── docs/
│   ├── NETWORK_ARCHITECTURE.md               # Part 1: Topologi Mermaid/ASCII, 802.1Q VLAN Matrix, Failover <3s & QoS
│   └── RCA.md                                # Part 2: Root Cause Analysis Deadlock & Duplicate Capture
├── src/
│   ├── patch/
│   │   ├── checkout_handler.ts               # Part 2: Atomic Lock + Fencing Token + Strict Idempotency Checkout Handler
│   │   └── test_concurrency.ts               # Part 2: Suite verifikasi 5 skenario concurrency, stale fencing & recovery
│   └── engine/
│       ├── triage_engine.ts                  # Part 3: Multi-flag Fleet Telemetry Triage Engine
│       └── dispatcher.ts                     # Part 3: Structured Alert Formatter + Full Jitter Retry + Reconciliation Export
├── data/
│   └── outage_telemetry.json                 # Part 3: Dataset telemetri armada Kuta Hub (8 kendaraan)
├── output/
│   └── incident_reconciliation.json          # Part 3: Output hasil rekonsiliasi & log retry dispatch (auto-generated)
└── ai_session_logs/
    └── STEERING_AUDIT.md                     # Part 4: Audit log koreksi/steering engineer atas hasil AI
```

---

## Prasyarat & Instalasi

### Prasyarat
- **Node.js** `v20+` (disarankan LTS v20 atau v22)
- **npm** `v9+`

### Instalasi Dependensi

```bash
npm install
```

---

## Cara Menjalankan Verifikasi

Jalankan perintah berikut dari root direktori proyek:

### 1. TypeScript Static Typecheck
Memastikan seluruh kode TypeScript (`src/patch/*` dan `src/engine/*`) bebas error pada mode `strict`:

```bash
npm run typecheck
```

### 2. Verifikasi Concurrency, Fencing Token & Idempotency (Part 2)
Menjalankan 5 skenario uji otomatis pada `src/patch/test_concurrency.ts`:
- **Test 1:** Kiosk Retry Storm (5 concurrent requests, `Idempotency-Key` sama → 1× `201`, 4× `409 IDEMPOTENCY_IN_PROGRESS`, 1× payment capture, replay `200` aman, payload mismatch `409`).
- **Test 2:** Vehicle Lock Contention (5 concurrent requests, key berbeda → 1× `201`, 4× `409 VEHICLE_LOCK_CONFLICT`, 0 deadlock, 1× capture).
- **Test 3:** Transient `502` Payment Gateway Failure → hold di-release, `Idempotency-Key` dibersihkan (tidak nyangkut `IN_PROGRESS` / tidak di-cache `502`), retry key sama langsung sukses `201`.
- **Test 4:** Unhandled Exceptions (lock backend error, DB reset, compensation failure) → `Idempotency-Key` & lock selalu dilepas, retry langsung sukses `201`.
- **Test 5:** Monotonic `fencingToken` validation → menolak stale write (`incomingToken < lastAcceptedToken`) dengan HTTP `409 STALE_FENCING_TOKEN` baik saat `createPendingHold` maupun `confirmHold`.

```bash
npm run test:concurrency
```

### 3. Jalankan Real-Time Fleet & Network Self-Healing Engine (Part 3)
Membaca `data/outage_telemetry.json`, melakukan triase multi-flag, menyimulasikan pengiriman alert dengan **Exponential Backoff + Full Jitter** (18% packet loss), dan mengekspor laporan lengkap ke `output/incident_reconciliation.json`:

```bash
npm run engine:run
```

> **Catatan untuk Windows PowerShell:** Jika ExecutionPolicy memblokir `npm.ps1`, gunakan `npm.cmd` (contoh: `npm.cmd run typecheck`, `npm.cmd run test:concurrency`, `npm.cmd run engine:run`).

---

## Panduan Cepat untuk Reviewer

- **Arsitektur Jaringan & Failover (Part 1):** [`docs/NETWORK_ARCHITECTURE.md`](./docs/NETWORK_ARCHITECTURE.md)
- **Root Cause Analysis Deadlock & Duplicate Capture (Part 2):** [`docs/RCA.md`](./docs/RCA.md)
- **Implementasi & Pengujian Patch Checkout (Part 2):** [`src/patch/checkout_handler.ts`](./src/patch/checkout_handler.ts) & [`src/patch/test_concurrency.ts`](./src/patch/test_concurrency.ts)
- **Fleet Triage & Self-Healing Dispatcher (Part 3):** [`src/engine/triage_engine.ts`](./src/engine/triage_engine.ts) & [`src/engine/dispatcher.ts`](./src/engine/dispatcher.ts)
- **Hasil Rekonsiliasi Insiden (Part 3):** [`output/incident_reconciliation.json`](./output/incident_reconciliation.json)
- **Log Audit & Steering AI (Part 4):** [`ai_session_logs/STEERING_AUDIT.md`](./ai_session_logs/STEERING_AUDIT.md)
