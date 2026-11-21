import { createHash, randomUUID } from "node:crypto";

// ============================================================================
// Domain Types & Contracts
// ============================================================================

export interface CheckoutPayload {
  booking_id: string;
  vehicle_id: string;
  customer_id: string;
  amount_idr?: number;
}

export interface CheckoutRequest {
  idempotencyKey: string;
  payload: CheckoutPayload;
}

export type ReservationStatus = "PENDING" | "CONFIRMED" | "RELEASED";

export interface VehicleReservation {
  reservationId: string;
  bookingId: string;
  vehicleId: string;
  customerId: string;
  status: ReservationStatus;
  fencingToken: number;
  paymentCaptureId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckoutSuccessBody {
  ok: true;
  idempotent_replay: boolean;
  reservation: VehicleReservation;
  payment: {
    capture_id: string;
    amount_idr: number;
    gateway_idempotency_key: string;
  };
}

export type CheckoutErrorCode =
  | "INVALID_REQUEST"
  | "MISSING_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "VEHICLE_LOCK_CONFLICT"
  | "VEHICLE_ALREADY_RESERVED"
  | "BOOKING_ALREADY_CONFIRMED"
  | "STALE_FENCING_TOKEN"
  | "PAYMENT_CAPTURE_FAILED";

export interface CheckoutErrorBody {
  ok: false;
  error: {
    code: CheckoutErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export interface CheckoutResponse {
  status: 200 | 201 | 400 | 409 | 502;
  headers: Record<string, string>;
  body: CheckoutSuccessBody | CheckoutErrorBody;
}

// ============================================================================
// Distributed / Atomic Lock Abstraction (Fail-Fast, Lease + Fencing Token)
// ============================================================================

export interface LockLease {
  resourceKey: string;
  ownerToken: string;
  fencingToken: number;
  expiresAtMs: number;
}

export interface DistributedLockManager {
  /**
   * Non-blocking atomic lock acquisition (equivalent to Redis `SET key token NX PX ttl`
   * or PostgreSQL `pg_try_advisory_xact_lock`). Returns null immediately on contention
   * so circular wait / deadlock can never occur.
   */
  tryAcquire(resourceKey: string, ttlMs: number): LockLease | null;

  /**
   * Releases the lock only if the caller still owns the exact ownerToken
   * (equivalent to Redis Lua compare-and-delete script).
   */
  release(lease: LockLease): boolean;
}

export class InMemoryAtomicLockManager implements DistributedLockManager {
  private readonly locks = new Map<string, LockLease>();
  private fencingCounter = 0;

  tryAcquire(resourceKey: string, ttlMs: number): LockLease | null {
    const now = Date.now();
    const existing = this.locks.get(resourceKey);

    // Purge expired lease to prevent orphaned locks after worker crashes
    if (existing && existing.expiresAtMs > now) {
      return null;
    }

    const lease: LockLease = {
      resourceKey,
      ownerToken: randomUUID(),
      fencingToken: ++this.fencingCounter,
      expiresAtMs: now + ttlMs,
    };

    this.locks.set(resourceKey, lease);
    return lease;
  }

  release(lease: LockLease): boolean {
    const current = this.locks.get(lease.resourceKey);
    if (!current || current.ownerToken !== lease.ownerToken) {
      return false;
    }
    this.locks.delete(lease.resourceKey);
    return true;
  }

  getActiveLockCount(): number {
    const now = Date.now();
    let count = 0;
    for (const lease of this.locks.values()) {
      if (lease.expiresAtMs > now) count++;
    }
    return count;
  }
}

// ============================================================================
// Strict Idempotency Key Deduplication Store
// ============================================================================

export type IdempotencyClaimResult =
  | { outcome: "CLAIMED"; claimToken: string }
  | { outcome: "IN_PROGRESS" }
  | { outcome: "PAYLOAD_MISMATCH" }
  | { outcome: "COMPLETED"; cachedResponse: CheckoutSuccessBody };

export type IdempotencyStatus = "IN_PROGRESS" | "COMPLETED";

interface IdempotencyRecord {
  key: string;
  claimToken: string;
  payloadHash: string;
  status: IdempotencyStatus;
  cachedResponse?: CheckoutSuccessBody;
  expiresAtMs: number;
}

export interface IdempotencyStore {
  tryClaim(key: string, payloadHash: string, ttlMs: number): IdempotencyClaimResult;
  complete(key: string, response: CheckoutSuccessBody, ttlMs: number, claimToken?: string): void;
  release(key: string, claimToken?: string): void;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  tryClaim(key: string, payloadHash: string, ttlMs: number): IdempotencyClaimResult {
    const now = Date.now();
    const existing = this.records.get(key);

    if (existing && existing.expiresAtMs > now) {
      if (existing.payloadHash !== payloadHash) {
        return { outcome: "PAYLOAD_MISMATCH" };
      }
      if (existing.status === "IN_PROGRESS") {
        return { outcome: "IN_PROGRESS" };
      }
      if (existing.status === "COMPLETED" && existing.cachedResponse) {
        return { outcome: "COMPLETED", cachedResponse: existing.cachedResponse };
      }
    }

    const claimToken = randomUUID();

    // Atomic compare-and-set into IN_PROGRESS state
    this.records.set(key, {
      key,
      claimToken,
      payloadHash,
      status: "IN_PROGRESS",
      expiresAtMs: now + ttlMs,
    });

    return { outcome: "CLAIMED", claimToken };
  }

  complete(key: string, response: CheckoutSuccessBody, ttlMs: number, claimToken?: string): void {
    const existing = this.records.get(key);
    if (!existing) return;
    if (claimToken && existing.claimToken !== claimToken) return;

    this.records.set(key, {
      ...existing,
      status: "COMPLETED",
      cachedResponse: response,
      expiresAtMs: Date.now() + ttlMs,
    });
  }

  release(key: string, claimToken?: string): void {
    const existing = this.records.get(key);
    if (!existing || existing.status !== "IN_PROGRESS") return;
    if (claimToken && existing.claimToken !== claimToken) return;

    this.records.delete(key);
  }

  getStatus(key: string): IdempotencyStatus | null {
    const existing = this.records.get(key);
    if (!existing) return null;
    if (existing.expiresAtMs <= Date.now()) {
      this.records.delete(key);
      return null;
    }
    return existing.status;
  }

  has(key: string): boolean {
    return this.getStatus(key) !== null;
  }
}

// ============================================================================
// Vehicle Reservation Repository (Reserve-Before-Capture Storage)
// ============================================================================

export type ReservationConflictCode =
  | "VEHICLE_ALREADY_RESERVED"
  | "BOOKING_ALREADY_CONFIRMED"
  | "STALE_FENCING_TOKEN";

export class ReservationConflictError extends Error {
  constructor(
    public readonly code: ReservationConflictCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ReservationConflictError";
  }
}

export interface ReservationRepository {
  createPendingHold(params: {
    bookingId: string;
    vehicleId: string;
    customerId: string;
    fencingToken: number;
  }): Promise<VehicleReservation>;

  confirmHold(
    reservationId: string,
    paymentCaptureId: string,
    fencingToken: number
  ): Promise<VehicleReservation>;

  releaseHold(reservationId: string): Promise<void>;
  getConfirmedReservations(): VehicleReservation[];
}

export class InMemoryReservationRepository implements ReservationRepository {
  private readonly reservations = new Map<string, VehicleReservation>();
  private readonly lastAcceptedTokenByVehicle = new Map<string, number>();

  constructor(private readonly simulatedDbLatencyMs = 15) {}

  private assertFreshFencingToken(vehicleId: string, incomingToken: number): void {
    const lastAcceptedToken = this.lastAcceptedTokenByVehicle.get(vehicleId) ?? 0;
    if (!Number.isFinite(incomingToken) || incomingToken <= 0 || incomingToken < lastAcceptedToken) {
      throw new ReservationConflictError(
        "STALE_FENCING_TOKEN",
        `Stale fencing token for vehicle '${vehicleId}': incoming (${incomingToken}) < lastAccepted (${lastAcceptedToken}).`,
        {
          incoming_fencing_token: incomingToken,
          last_accepted_fencing_token: lastAcceptedToken,
        }
      );
    }
  }

  async createPendingHold(params: {
    bookingId: string;
    vehicleId: string;
    customerId: string;
    fencingToken: number;
  }): Promise<VehicleReservation> {
    await delay(this.simulatedDbLatencyMs);

    // Enforce monotonic fencing token to reject stale lock holders before any state mutation
    this.assertFreshFencingToken(params.vehicleId, params.fencingToken);

    for (const existing of this.reservations.values()) {
      if (existing.status === "RELEASED") continue;

      if (existing.bookingId === params.bookingId && existing.status === "CONFIRMED") {
        throw new ReservationConflictError(
          "BOOKING_ALREADY_CONFIRMED",
          `Booking '${params.bookingId}' is already confirmed.`
        );
      }

      if (existing.vehicleId === params.vehicleId) {
        throw new ReservationConflictError(
          "VEHICLE_ALREADY_RESERVED",
          `Vehicle '${params.vehicleId}' already has an active ${existing.status} hold.`
        );
      }
    }

    this.lastAcceptedTokenByVehicle.set(params.vehicleId, params.fencingToken);

    const nowIso = new Date().toISOString();
    const reservation: VehicleReservation = {
      reservationId: `res_${randomUUID().slice(0, 8)}`,
      bookingId: params.bookingId,
      vehicleId: params.vehicleId,
      customerId: params.customerId,
      status: "PENDING",
      fencingToken: params.fencingToken,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.reservations.set(reservation.reservationId, reservation);
    return { ...reservation };
  }

  async confirmHold(
    reservationId: string,
    paymentCaptureId: string,
    fencingToken: number
  ): Promise<VehicleReservation> {
    await delay(this.simulatedDbLatencyMs);

    const existing = this.reservations.get(reservationId);
    if (!existing) {
      throw new Error(`Reservation '${reservationId}' not found during confirmation.`);
    }

    // Validate monotonic fencing token against the vehicle's lastAcceptedToken FIRST
    this.assertFreshFencingToken(existing.vehicleId, fencingToken);

    if (existing.fencingToken !== fencingToken) {
      throw new ReservationConflictError(
        "STALE_FENCING_TOKEN",
        `Fencing token mismatch confirming reservation '${reservationId}': expected ${existing.fencingToken}, received ${fencingToken}.`,
        {
          incoming_fencing_token: fencingToken,
          expected_fencing_token: existing.fencingToken,
          last_accepted_fencing_token: this.lastAcceptedTokenByVehicle.get(existing.vehicleId) ?? 0,
        }
      );
    }

    if (existing.status === "CONFIRMED") {
      throw new ReservationConflictError(
        "BOOKING_ALREADY_CONFIRMED",
        `Booking '${existing.bookingId}' is already confirmed.`
      );
    }

    if (existing.status !== "PENDING") {
      throw new ReservationConflictError(
        "VEHICLE_ALREADY_RESERVED",
        `Reservation '${reservationId}' is no longer pending (current status: ${existing.status}).`
      );
    }

    this.lastAcceptedTokenByVehicle.set(existing.vehicleId, fencingToken);

    const confirmed: VehicleReservation = {
      ...existing,
      status: "CONFIRMED",
      paymentCaptureId,
      updatedAt: new Date().toISOString(),
    };

    this.reservations.set(reservationId, confirmed);
    return { ...confirmed };
  }

  async releaseHold(reservationId: string): Promise<void> {
    await delay(Math.min(this.simulatedDbLatencyMs, 5));
    const existing = this.reservations.get(reservationId);
    if (!existing || existing.status === "CONFIRMED") return;

    this.reservations.set(reservationId, {
      ...existing,
      status: "RELEASED",
      updatedAt: new Date().toISOString(),
    });
  }

  getLastAcceptedFencingToken(vehicleId: string): number {
    return this.lastAcceptedTokenByVehicle.get(vehicleId) ?? 0;
  }

  getConfirmedReservations(): VehicleReservation[] {
    return [...this.reservations.values()]
      .filter((r) => r.status === "CONFIRMED")
      .map((r) => ({ ...r }));
  }

  getAllReservations(): VehicleReservation[] {
    return [...this.reservations.values()].map((r) => ({ ...r }));
  }
}

// ============================================================================
// Payment Gateway Abstraction (Idempotent Capture)
// ============================================================================

export interface PaymentCaptureRequest {
  bookingId: string;
  customerId: string;
  amountIdr: number;
  gatewayIdempotencyKey: string;
}

export interface PaymentCaptureResult {
  captureId: string;
  amountIdr: number;
  gatewayIdempotencyKey: string;
}

export interface PaymentGateway {
  capture(request: PaymentCaptureRequest): Promise<PaymentCaptureResult>;
}

export class MockPaymentGateway implements PaymentGateway {
  public readonly captureHistory: Array<PaymentCaptureRequest & { captureId: string }> = [];
  private readonly capturesByIdempotencyKey = new Map<string, PaymentCaptureResult>();

  constructor(
    private readonly simulatedLatencyMs = 50,
    private shouldFailNext = false
  ) {}

  setFailNext(shouldFail: boolean): void {
    this.shouldFailNext = shouldFail;
  }

  async capture(request: PaymentCaptureRequest): Promise<PaymentCaptureResult> {
    await delay(this.simulatedLatencyMs);

    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error("PSP_CARD_DECLINED_OR_TIMEOUT");
    }

    // Defense-in-depth: Gateway-level idempotency deduplication
    const existing = this.capturesByIdempotencyKey.get(request.gatewayIdempotencyKey);
    if (existing) {
      return existing;
    }

    const result: PaymentCaptureResult = {
      captureId: `cap_${randomUUID().slice(0, 8)}`,
      amountIdr: request.amountIdr,
      gatewayIdempotencyKey: request.gatewayIdempotencyKey,
    };

    this.capturesByIdempotencyKey.set(request.gatewayIdempotencyKey, result);
    this.captureHistory.push({ ...request, captureId: result.captureId });
    return result;
  }
}

// ============================================================================
// Checkout Handler (Atomic Lock + Strict Idempotency + Graceful 409 Conflict)
// ============================================================================

export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PaymentGatewayError";
  }
}

export interface CheckoutHandlerOptions {
  lockManager: DistributedLockManager;
  idempotencyStore: IdempotencyStore;
  reservationRepo: ReservationRepository;
  paymentGateway: PaymentGateway;
  lockTtlMs?: number;
  idempotencyInProgressTtlMs?: number;
  idempotencyCompletedTtlMs?: number;
  defaultAmountIdr?: number;
}

export class CheckoutHandler {
  private readonly lockManager: DistributedLockManager;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly reservationRepo: ReservationRepository;
  private readonly paymentGateway: PaymentGateway;
  private readonly lockTtlMs: number;
  private readonly idempotencyInProgressTtlMs: number;
  private readonly idempotencyCompletedTtlMs: number;
  private readonly defaultAmountIdr: number;

  constructor(options: CheckoutHandlerOptions) {
    this.lockManager = options.lockManager;
    this.idempotencyStore = options.idempotencyStore;
    this.reservationRepo = options.reservationRepo;
    this.paymentGateway = options.paymentGateway;
    this.lockTtlMs = options.lockTtlMs ?? 15_000;
    this.idempotencyInProgressTtlMs = options.idempotencyInProgressTtlMs ?? 30_000;
    this.idempotencyCompletedTtlMs = options.idempotencyCompletedTtlMs ?? 24 * 60 * 60 * 1_000;
    this.defaultAmountIdr = options.defaultAmountIdr ?? 450_000;
  }

  async handle(request: CheckoutRequest): Promise<CheckoutResponse> {
    // 1. Validate Idempotency-Key & Payload
    const idempotencyKey = request.idempotencyKey?.trim();
    if (!idempotencyKey) {
      return errorResponse(400, "MISSING_IDEMPOTENCY_KEY", "Header 'Idempotency-Key' is required.", false);
    }

    const { payload } = request;
    if (!payload?.booking_id?.trim() || !payload?.vehicle_id?.trim() || !payload?.customer_id?.trim()) {
      return errorResponse(
        400,
        "INVALID_REQUEST",
        "Fields 'booking_id', 'vehicle_id', and 'customer_id' are required.",
        false
      );
    }

    const amountIdr = payload.amount_idr ?? this.defaultAmountIdr;
    const payloadHash = computePayloadHash({
      booking_id: payload.booking_id,
      vehicle_id: payload.vehicle_id,
      customer_id: payload.customer_id,
      amount_idr: amountIdr,
    });

    // 2. Strict Idempotency Key Deduplication (Atomic Claim)
    const claim = this.idempotencyStore.tryClaim(
      idempotencyKey,
      payloadHash,
      this.idempotencyInProgressTtlMs
    );

    if (claim.outcome === "PAYLOAD_MISMATCH") {
      return errorResponse(
        409,
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        `Idempotency-Key '${idempotencyKey}' was already used with a different checkout payload.`,
        false,
        { idempotency_key: idempotencyKey }
      );
    }

    if (claim.outcome === "IN_PROGRESS") {
      return errorResponse(
        409,
        "IDEMPOTENCY_IN_PROGRESS",
        `A checkout request with Idempotency-Key '${idempotencyKey}' is already being processed.`,
        true,
        { idempotency_key: idempotencyKey, booking_id: payload.booking_id },
        { "Retry-After": "2" }
      );
    }

    if (claim.outcome === "COMPLETED") {
      return {
        status: 200,
        headers: { "X-Idempotent-Replay": "true" },
        body: {
          ...claim.cachedResponse,
          idempotent_replay: true,
        },
      };
    }

    const claimToken = claim.claimToken;
    let idempotencyCompleted = false;
    let lease: LockLease | null = null;
    let pendingHold: VehicleReservation | null = null;

    try {
      // 3. Acquire Non-Blocking Atomic Lock on Vehicle Resource (Eliminates Deadlock)
      const vehicleLockKey = `lock:vehicle:${payload.vehicle_id}`;
      lease = this.lockManager.tryAcquire(vehicleLockKey, this.lockTtlMs);

      if (!lease) {
        return errorResponse(
          409,
          "VEHICLE_LOCK_CONFLICT",
          `Vehicle '${payload.vehicle_id}' is currently locked by another concurrent checkout. Please retry after a short delay.`,
          true,
          { vehicle_id: payload.vehicle_id, booking_id: payload.booking_id },
          { "Retry-After": "2" }
        );
      }

      // 4. Reserve-Before-Capture: Persist PENDING vehicle hold before touching Payment Gateway
      pendingHold = await this.reservationRepo.createPendingHold({
        bookingId: payload.booking_id,
        vehicleId: payload.vehicle_id,
        customerId: payload.customer_id,
        fencingToken: lease.fencingToken,
      });

      // 5. Execute Idempotent Payment Capture ONLY after vehicle hold is atomically secured
      const gatewayIdempotencyKey = `capture:${payload.booking_id}:${idempotencyKey}`;
      let captureResult: PaymentCaptureResult;
      try {
        captureResult = await this.paymentGateway.capture({
          bookingId: payload.booking_id,
          customerId: payload.customer_id,
          amountIdr,
          gatewayIdempotencyKey,
        });
      } catch (gatewayErr) {
        const reason = gatewayErr instanceof Error ? gatewayErr.message : "Unknown payment gateway error";
        throw new PaymentGatewayError(reason, gatewayErr);
      }

      // 6. Confirm Vehicle Hold with Fencing Token verification
      const confirmedReservation = await this.reservationRepo.confirmHold(
        pendingHold.reservationId,
        captureResult.captureId,
        lease.fencingToken
      );

      const successBody: CheckoutSuccessBody = {
        ok: true,
        idempotent_replay: false,
        reservation: confirmedReservation,
        payment: {
          capture_id: captureResult.captureId,
          amount_idr: captureResult.amountIdr,
          gateway_idempotency_key: captureResult.gatewayIdempotencyKey,
        },
      };

      // 7. Persist Completed Idempotency Record (ONLY on 201 success — never cache 4xx/5xx)
      this.idempotencyStore.complete(
        idempotencyKey,
        successBody,
        this.idempotencyCompletedTtlMs,
        claimToken
      );
      idempotencyCompleted = true;

      return {
        status: 201,
        headers: { "X-Idempotent-Replay": "false" },
        body: successBody,
      };
    } catch (err) {
      // Compensating action: release pending hold if payment, confirmation, or unexpected error failed
      if (pendingHold) {
        try {
          await this.reservationRepo.releaseHold(pendingHold.reservationId);
        } catch {
          // Swallow compensation failure so finally still releases idempotency key & lock cleanly
        }
      }

      if (err instanceof ReservationConflictError) {
        return errorResponse(
          409,
          err.code,
          err.message,
          err.code === "STALE_FENCING_TOKEN",
          {
            vehicle_id: payload.vehicle_id,
            booking_id: payload.booking_id,
            ...(err.details ?? {}),
          }
        );
      }

      if (err instanceof PaymentGatewayError) {
        return errorResponse(
          502,
          "PAYMENT_CAPTURE_FAILED",
          `Payment capture failed and pending vehicle hold was safely released: ${err.message}`,
          true,
          { booking_id: payload.booking_id, vehicle_id: payload.vehicle_id }
        );
      }

      // Rethrow unhandled exceptions after finally cleans up IN_PROGRESS idempotency entry and lock
      throw err;
    } finally {
      // Guarantee IN_PROGRESS idempotency entry is released on ANY non-completed exit (409, 502, or unhandled exception)
      if (!idempotencyCompleted) {
        this.idempotencyStore.release(idempotencyKey, claimToken);
      }

      // Always release atomic distributed lock using owner-verified compare-and-delete
      if (lease) {
        this.lockManager.release(lease);
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function computePayloadHash(payload: Required<CheckoutPayload>): string {
  const canonical = JSON.stringify({
    amount_idr: payload.amount_idr,
    booking_id: payload.booking_id,
    customer_id: payload.customer_id,
    vehicle_id: payload.vehicle_id,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function errorResponse(
  status: 400 | 409 | 502,
  code: CheckoutErrorCode,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): CheckoutResponse {
  return {
    status,
    headers: { ...extraHeaders },
    body: {
      ok: false,
      error: {
        code,
        message,
        retryable,
        ...(details ? { details } : {}),
      },
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
