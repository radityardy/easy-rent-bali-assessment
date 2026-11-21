import assert from "node:assert/strict";
import {
  CheckoutHandler,
  InMemoryAtomicLockManager,
  InMemoryIdempotencyStore,
  InMemoryReservationRepository,
  MockPaymentGateway,
  ReservationConflictError,
  type CheckoutPayload,
  type CheckoutResponse,
  type DistributedLockManager,
  type LockLease,
  type PaymentCaptureRequest,
  type PaymentCaptureResult,
  type PaymentGateway,
} from "./checkout_handler.js";

const INCIDENT_PAYLOAD: CheckoutPayload = {
  booking_id: "erb_kuta_9941",
  vehicle_id: "car_avanza_04",
  customer_id: "cust_foreign_881",
  amount_idr: 450_000,
};

function createTestHarness() {
  const lockManager = new InMemoryAtomicLockManager();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const reservationRepo = new InMemoryReservationRepository(25);
  const paymentGateway = new MockPaymentGateway(60);

  const handler = new CheckoutHandler({
    lockManager,
    idempotencyStore,
    reservationRepo,
    paymentGateway,
  });

  return { handler, lockManager, idempotencyStore, reservationRepo, paymentGateway };
}

function summarizeResponses(responses: CheckoutResponse[]): void {
  responses.forEach((res, idx) => {
    if (res.body.ok) {
      console.log(
        `  [Req #${idx + 1}] HTTP ${res.status} OK | replay=${res.body.idempotent_replay} | reservation=${res.body.reservation.reservationId} (${res.body.reservation.status}) | capture=${res.body.payment.capture_id}`
      );
    } else {
      console.log(
        `  [Req #${idx + 1}] HTTP ${res.status} ${res.body.error.code} | retryable=${res.body.error.retryable} | ${res.body.error.message}`
      );
    }
  });
}

async function testSameIdempotencyKeyRetryStorm(): Promise<void> {
  console.log("\n=== Test 1: Kiosk Retry Storm (5 Concurrent Requests, Same Idempotency-Key) ===");
  const { handler, lockManager, reservationRepo, paymentGateway } = createTestHarness();
  const sharedKey = "kiosk-kuta-erb_kuta_9941-attempt-1";

  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      handler.handle({
        idempotencyKey: sharedKey,
        payload: { ...INCIDENT_PAYLOAD },
      })
    )
  );

  summarizeResponses(responses);

  const succeeded = responses.filter((r) => r.status === 201 && r.body.ok);
  const conflicted = responses.filter((r) => r.status === 409 && !r.body.ok);

  assert.equal(succeeded.length, 1, "Expected exactly 1 request to succeed with HTTP 201");
  assert.equal(conflicted.length, 4, "Expected exactly 4 requests to be gracefully rejected with HTTP 409");

  for (const conflict of conflicted) {
    assert.equal(conflict.body.ok, false);
    if (!conflict.body.ok) {
      assert.equal(conflict.body.error.code, "IDEMPOTENCY_IN_PROGRESS");
      assert.equal(conflict.body.error.retryable, true);
    }
    assert.equal(conflict.headers["Retry-After"], "2");
  }

  assert.equal(paymentGateway.captureHistory.length, 1, "Expected exactly 1 credit card capture (zero duplicates)");
  assert.equal(reservationRepo.getConfirmedReservations().length, 1, "Expected exactly 1 confirmed vehicle hold");
  assert.equal(lockManager.getActiveLockCount(), 0, "Expected all distributed locks to be released");

  // Verify post-completion idempotent replay returns cached 200 without re-charging card
  const replay = await handler.handle({
    idempotencyKey: sharedKey,
    payload: { ...INCIDENT_PAYLOAD },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["X-Idempotent-Replay"], "true");
  assert.equal(replay.body.ok, true);
  if (replay.body.ok && succeeded[0]?.body.ok) {
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(replay.body.payment.capture_id, succeeded[0].body.payment.capture_id);
  }
  assert.equal(paymentGateway.captureHistory.length, 1, "Idempotent replay must not trigger another capture");

  // Verify idempotency key reuse with a mutated payload is rejected with 409
  const mismatch = await handler.handle({
    idempotencyKey: sharedKey,
    payload: { ...INCIDENT_PAYLOAD, vehicle_id: "car_innova_01" },
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.ok, false);
  if (!mismatch.body.ok) {
    assert.equal(mismatch.body.error.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  }

  console.log("  PASS: 1 succeeded (201), 4 rejected gracefully (409), 1 capture, 1 confirmed hold, safe replay verified.");
}

async function testDistinctKeysVehicleLockContention(): Promise<void> {
  console.log("\n=== Test 2: Vehicle Lock Contention (5 Concurrent Requests, Distinct Idempotency-Keys) ===");
  const { handler, lockManager, reservationRepo, paymentGateway } = createTestHarness();

  const responses = await Promise.all(
    Array.from({ length: 5 }, (_, idx) =>
      handler.handle({
        idempotencyKey: `kiosk-kuta-storm-key-${idx + 1}`,
        payload: {
          ...INCIDENT_PAYLOAD,
          booking_id: idx === 0 ? INCIDENT_PAYLOAD.booking_id : `erb_kuta_9941_dup_${idx + 1}`,
        },
      })
    )
  );

  summarizeResponses(responses);

  const succeeded = responses.filter((r) => r.status === 201 && r.body.ok);
  const conflicted = responses.filter((r) => r.status === 409 && !r.body.ok);

  assert.equal(succeeded.length, 1, "Expected exactly 1 request to acquire the atomic vehicle lock and succeed");
  assert.equal(conflicted.length, 4, "Expected exactly 4 concurrent requests to fail fast with HTTP 409");

  for (const conflict of conflicted) {
    assert.equal(conflict.body.ok, false);
    if (!conflict.body.ok) {
      assert.equal(conflict.body.error.code, "VEHICLE_LOCK_CONFLICT");
      assert.equal(conflict.body.error.retryable, true);
    }
    assert.equal(conflict.headers["Retry-After"], "2");
  }

  assert.equal(paymentGateway.captureHistory.length, 1, "Expected exactly 1 payment capture under lock contention");
  assert.equal(reservationRepo.getConfirmedReservations().length, 1, "Expected exactly 1 confirmed reservation");
  assert.equal(lockManager.getActiveLockCount(), 0, "Expected zero lingering locks after completion");

  // Subsequent checkout for the same vehicle after lock release must still be rejected as VEHICLE_ALREADY_RESERVED
  const postConfirmAttempt = await handler.handle({
    idempotencyKey: "kiosk-kuta-late-arrival-6",
    payload: {
      booking_id: "erb_kuta_9999",
      vehicle_id: INCIDENT_PAYLOAD.vehicle_id,
      customer_id: "cust_other_102",
      amount_idr: 450_000,
    },
  });
  assert.equal(postConfirmAttempt.status, 409);
  assert.equal(postConfirmAttempt.body.ok, false);
  if (!postConfirmAttempt.body.ok) {
    assert.equal(postConfirmAttempt.body.error.code, "VEHICLE_ALREADY_RESERVED");
  }
  assert.equal(paymentGateway.captureHistory.length, 1, "Late conflicting booking must not trigger payment capture");

  console.log("  PASS: 1 succeeded (201), 4 rejected gracefully (409 VEHICLE_LOCK_CONFLICT), 0 deadlocks, 1 capture.");
}

async function testPaymentFailureCompensation(): Promise<void> {
  console.log("\n=== Test 3: Payment Gateway 502 Failure -> Idempotency Cleanup & Immediate Same-Key Retry ===");
  const { handler, lockManager, idempotencyStore, reservationRepo, paymentGateway } = createTestHarness();
  paymentGateway.setFailNext(true);

  const req = {
    idempotencyKey: "kiosk-kuta-recovery-key-1",
    payload: {
      booking_id: "erb_kuta_9942",
      vehicle_id: "car_brio_07",
      customer_id: "cust_foreign_882",
      amount_idr: 300_000,
    },
  };

  const failedRes = await handler.handle(req);
  assert.equal(failedRes.status, 502);
  assert.equal(failedRes.body.ok, false);
  if (!failedRes.body.ok) {
    assert.equal(failedRes.body.error.code, "PAYMENT_CAPTURE_FAILED");
    assert.equal(failedRes.body.error.retryable, true);
  }
  assert.equal(reservationRepo.getConfirmedReservations().length, 0, "Failed capture must leave 0 confirmed holds");
  assert.equal(
    reservationRepo.getAllReservations().every((r) => r.status === "RELEASED"),
    true,
    "Pending hold must be compensated to RELEASED"
  );
  assert.equal(lockManager.getActiveLockCount(), 0, "Lock must be released after failure");

  // Explicitly verify Idempotency-Key was removed (neither stuck in IN_PROGRESS nor cached as 502)
  assert.equal(
    idempotencyStore.getStatus(req.idempotencyKey),
    null,
    "Idempotency-Key entry must be deleted after transient 502 failure"
  );
  assert.equal(
    idempotencyStore.has(req.idempotencyKey),
    false,
    "502 response must never remain cached in IdempotencyStore"
  );

  // Immediate kiosk retry with the EXACT SAME Idempotency-Key after gateway recovers must succeed (201)
  const retryRes = await handler.handle(req);
  assert.equal(retryRes.status, 201);
  assert.equal(retryRes.headers["X-Idempotent-Replay"], "false");
  assert.equal(retryRes.body.ok, true);
  if (retryRes.body.ok) {
    assert.equal(retryRes.body.idempotent_replay, false);
  }
  assert.equal(paymentGateway.captureHistory.length, 1);
  assert.equal(reservationRepo.getConfirmedReservations().length, 1);
  assert.equal(idempotencyStore.getStatus(req.idempotencyKey), "COMPLETED");

  // Subsequent replay with the same key now returns cached 200 without charging again
  const replayRes = await handler.handle(req);
  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.headers["X-Idempotent-Replay"], "true");
  assert.equal(paymentGateway.captureHistory.length, 1);

  console.log("  PASS: 502 failure cleaned up Idempotency-Key, pending hold & lock; same-key retry succeeded (201).");
}

async function testUnhandledExceptionIdempotencyCleanup(): Promise<void> {
  console.log("\n=== Test 4: Unhandled Exceptions -> Idempotency Cleanup & Same-Key Retry Recovery ===");
  const baseLockManager = new InMemoryAtomicLockManager();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const reservationRepo = new InMemoryReservationRepository(10);
  const paymentGateway = new MockPaymentGateway(15);

  // 4a. Unhandled exception thrown by lockManager.tryAcquire (before lock is even acquired)
  let failNextLockAcquire = true;
  const flakyLockManager: DistributedLockManager = {
    tryAcquire(resourceKey: string, ttlMs: number): LockLease | null {
      if (failNextLockAcquire) {
        failNextLockAcquire = false;
        throw new Error("LOCK_BACKEND_UNAVAILABLE");
      }
      return baseLockManager.tryAcquire(resourceKey, ttlMs);
    },
    release(lease: LockLease): boolean {
      return baseLockManager.release(lease);
    },
  };

  // 4b. Unhandled exception thrown by reservationRepo.createPendingHold (after lock is acquired)
  let failNextCreateHold = false;
  const originalCreateHold = reservationRepo.createPendingHold.bind(reservationRepo);
  reservationRepo.createPendingHold = async (params) => {
    if (failNextCreateHold) {
      failNextCreateHold = false;
      throw new Error("DB_CONNECTION_RESET");
    }
    return originalCreateHold(params);
  };

  // 4c. Unhandled exception thrown by reservationRepo.releaseHold during 502 compensation
  let failNextReleaseHold = false;
  const originalReleaseHold = reservationRepo.releaseHold.bind(reservationRepo);
  reservationRepo.releaseHold = async (reservationId) => {
    if (failNextReleaseHold) {
      failNextReleaseHold = false;
      throw new Error("COMPENSATION_DB_TIMEOUT");
    }
    return originalReleaseHold(reservationId);
  };

  const handler = new CheckoutHandler({
    lockManager: flakyLockManager,
    idempotencyStore,
    reservationRepo,
    paymentGateway,
  });

  // Scenario 4a: lockManager.tryAcquire throws unhandled exception
  const reqLockErr = {
    idempotencyKey: "kiosk-kuta-unhandled-lock-key-1",
    payload: {
      booking_id: "erb_kuta_9951",
      vehicle_id: "car_xpander_01",
      customer_id: "cust_foreign_901",
      amount_idr: 550_000,
    },
  };

  await assert.rejects(() => handler.handle(reqLockErr), /LOCK_BACKEND_UNAVAILABLE/);
  assert.equal(
    idempotencyStore.getStatus(reqLockErr.idempotencyKey),
    null,
    "Idempotency-Key must not stay stuck in IN_PROGRESS after lockManager exception"
  );
  assert.equal(baseLockManager.getActiveLockCount(), 0);

  const lockRetryRes = await handler.handle(reqLockErr);
  assert.equal(lockRetryRes.status, 201);
  assert.equal(lockRetryRes.body.ok, true);
  assert.equal(idempotencyStore.getStatus(reqLockErr.idempotencyKey), "COMPLETED");

  // Scenario 4b: reservationRepo.createPendingHold throws unhandled exception
  failNextCreateHold = true;
  const reqDbErr = {
    idempotencyKey: "kiosk-kuta-unhandled-db-key-2",
    payload: {
      booking_id: "erb_kuta_9952",
      vehicle_id: "car_xpander_02",
      customer_id: "cust_foreign_902",
      amount_idr: 550_000,
    },
  };

  await assert.rejects(() => handler.handle(reqDbErr), /DB_CONNECTION_RESET/);
  assert.equal(
    idempotencyStore.getStatus(reqDbErr.idempotencyKey),
    null,
    "Idempotency-Key must be released after unhandled DB exception"
  );
  assert.equal(baseLockManager.getActiveLockCount(), 0, "Lock must be released after unhandled DB exception");
  assert.equal(paymentGateway.captureHistory.length, 1, "No payment capture should happen on DB failure");

  const dbRetryRes = await handler.handle(reqDbErr);
  assert.equal(dbRetryRes.status, 201);
  assert.equal(dbRetryRes.body.ok, true);
  assert.equal(paymentGateway.captureHistory.length, 2);
  assert.equal(idempotencyStore.getStatus(reqDbErr.idempotencyKey), "COMPLETED");

  // Scenario 4c: 502 payment failure where releaseHold compensation itself throws -> idempotency & lock still cleaned up
  paymentGateway.setFailNext(true);
  failNextReleaseHold = true;
  const reqCompErr = {
    idempotencyKey: "kiosk-kuta-compensation-err-key-3",
    payload: {
      booking_id: "erb_kuta_9953",
      vehicle_id: "car_xpander_03",
      customer_id: "cust_foreign_903",
      amount_idr: 550_000,
    },
  };

  const compFailRes = await handler.handle(reqCompErr);
  assert.equal(compFailRes.status, 502);
  assert.equal(
    idempotencyStore.getStatus(reqCompErr.idempotencyKey),
    null,
    "Idempotency-Key must still be released even when releaseHold throws"
  );
  assert.equal(baseLockManager.getActiveLockCount(), 0, "Lock must still be released even when releaseHold throws");

  console.log("  PASS: Unhandled exceptions (lock, DB, compensation) release Idempotency-Key & lock; retries succeed (201).");
}

async function testMonotonicFencingTokenValidation(): Promise<void> {
  console.log("\n=== Test 5: Monotonic Fencing Token Validation (409 STALE_FENCING_TOKEN on Hold Create & Confirm) ===");
  const lockManager = new InMemoryAtomicLockManager();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const reservationRepo = new InMemoryReservationRepository(10);
  const paymentGateway = new MockPaymentGateway(15);

  const vehicleId = "car_fortuner_09";

  // 5a. Stale write on createPendingHold via CheckoutHandler (incomingToken < lastAcceptedToken -> 409 STALE_FENCING_TOKEN)
  // Worker A acquires lease1 (fencingToken = 1) and stalls before writing; lock expires and Worker B gets lease2 (fencingToken = 2).
  const staleLease = lockManager.tryAcquire(`lock:vehicle:${vehicleId}`, 10);
  assert.ok(staleLease, "Expected initial lease1 to be acquired");
  assert.equal(staleLease.fencingToken, 1);

  await new Promise((resolve) => setTimeout(resolve, 20));

  // Worker B runs through CheckoutHandler with lease2 (fencingToken = 2), fails payment so hold is RELEASED,
  // leaving lastAcceptedToken = 2 while vehicle has NO active hold (isolating STALE_FENCING_TOKEN check).
  paymentGateway.setFailNext(true);
  const workerBHandler = new CheckoutHandler({
    lockManager,
    idempotencyStore,
    reservationRepo,
    paymentGateway,
  });

  const workerBRes = await workerBHandler.handle({
    idempotencyKey: "kiosk-fence-worker-b-create-1",
    payload: {
      booking_id: "erb_fence_b_1",
      vehicle_id: vehicleId,
      customer_id: "cust_b_1",
      amount_idr: 900_000,
    },
  });
  assert.equal(workerBRes.status, 502);
  assert.equal(
    reservationRepo.getLastAcceptedFencingToken(vehicleId),
    2,
    "Expected lastAcceptedToken to advance monotonically to 2"
  );

  // Now paused Worker A wakes up holding staleLease (fencingToken = 1 < 2) and attempts createPendingHold via CheckoutHandler
  const staleLeaseLockManager: DistributedLockManager = {
    tryAcquire: () => staleLease,
    release: (lease) => lockManager.release(lease),
  };
  const staleWorkerAHandler = new CheckoutHandler({
    lockManager: staleLeaseLockManager,
    idempotencyStore,
    reservationRepo,
    paymentGateway,
  });

  const staleCreateReq = {
    idempotencyKey: "kiosk-fence-worker-a-stale-create-1",
    payload: {
      booking_id: "erb_fence_a_1",
      vehicle_id: vehicleId,
      customer_id: "cust_a_1",
      amount_idr: 900_000,
    },
  };

  const staleCreateRes = await staleWorkerAHandler.handle(staleCreateReq);
  assert.equal(staleCreateRes.status, 409, "Stale fencing token on createPendingHold must return HTTP 409");
  assert.equal(staleCreateRes.body.ok, false);
  if (!staleCreateRes.body.ok) {
    assert.equal(staleCreateRes.body.error.code, "STALE_FENCING_TOKEN");
    assert.equal(staleCreateRes.body.error.retryable, true);
    assert.equal(staleCreateRes.body.error.details?.incoming_fencing_token, 1);
    assert.equal(staleCreateRes.body.error.details?.last_accepted_fencing_token, 2);
  }
  assert.equal(paymentGateway.captureHistory.length, 0, "Stale fencing token must be rejected before payment capture");
  assert.equal(idempotencyStore.getStatus(staleCreateReq.idempotencyKey), null, "Rejected stale attempt must free Idempotency-Key");

  // 5b. Stale write on confirmHold via CheckoutHandler (GC pause during payment capture -> lease expires -> newer token advances store)
  const vehicleIdConfirm = "car_pajero_12";
  const confirmLockManager = new InMemoryAtomicLockManager();
  const confirmIdempotencyStore = new InMemoryIdempotencyStore();
  const confirmRepo = new InMemoryReservationRepository(5);
  const confirmGatewayB = new MockPaymentGateway(10);

  let signalWorkerAInCapture!: () => void;
  const workerAEnteredCapture = new Promise<void>((resolve) => {
    signalWorkerAInCapture = resolve;
  });
  let resumeWorkerACapture!: () => void;
  const workerAResumeGate = new Promise<void>((resolve) => {
    resumeWorkerACapture = resolve;
  });

  const pausedGatewayA: PaymentGateway = {
    async capture(request: PaymentCaptureRequest): Promise<PaymentCaptureResult> {
      signalWorkerAInCapture();
      await workerAResumeGate;
      return {
        captureId: "cap_stale_worker_a",
        amountIdr: request.amountIdr,
        gatewayIdempotencyKey: request.gatewayIdempotencyKey,
      };
    },
  };

  const handlerA = new CheckoutHandler({
    lockManager: confirmLockManager,
    idempotencyStore: confirmIdempotencyStore,
    reservationRepo: confirmRepo,
    paymentGateway: pausedGatewayA,
    lockTtlMs: 25,
  });

  const handlerB = new CheckoutHandler({
    lockManager: confirmLockManager,
    idempotencyStore: confirmIdempotencyStore,
    reservationRepo: confirmRepo,
    paymentGateway: confirmGatewayB,
    lockTtlMs: 5_000,
  });

  const workerAReq = {
    idempotencyKey: "kiosk-fence-confirm-a-1",
    payload: {
      booking_id: "erb_fence_confirm_a",
      vehicle_id: vehicleIdConfirm,
      customer_id: "cust_confirm_a",
      amount_idr: 1_200_000,
    },
  };

  // Start Worker A: acquires fencingToken=1, creates PENDING hold, then stalls inside payment capture
  const workerAPromise = handlerA.handle(workerAReq);
  await workerAEnteredCapture;

  const workerAHold = confirmRepo.getAllReservations().find((r) => r.bookingId === "erb_fence_confirm_a");
  assert.ok(workerAHold, "Worker A should have created a PENDING hold before capture");
  assert.equal(workerAHold.fencingToken, 1);

  // Wait for Worker A's lock lease (25ms) to expire and simulate hold TTL expiry releasing stale PENDING hold
  await new Promise((resolve) => setTimeout(resolve, 40));
  await confirmRepo.releaseHold(workerAHold.reservationId);

  // Worker B acquires a fresh lock (fencingToken=2) and completes checkout legitimately
  const workerBConfirmRes = await handlerB.handle({
    idempotencyKey: "kiosk-fence-confirm-b-2",
    payload: {
      booking_id: "erb_fence_confirm_b",
      vehicle_id: vehicleIdConfirm,
      customer_id: "cust_confirm_b",
      amount_idr: 1_200_000,
    },
  });
  assert.equal(workerBConfirmRes.status, 201);
  assert.equal(workerBConfirmRes.body.ok, true);
  if (workerBConfirmRes.body.ok) {
    assert.equal(workerBConfirmRes.body.reservation.fencingToken, 2);
  }
  assert.equal(confirmRepo.getLastAcceptedFencingToken(vehicleIdConfirm), 2);

  // Now resume paused Worker A -> it attempts confirmHold with stale fencingToken=1 (< lastAcceptedToken=2)
  resumeWorkerACapture();
  const workerAConfirmRes = await workerAPromise;

  assert.equal(workerAConfirmRes.status, 409, "Stale fencing token on confirmHold must return HTTP 409");
  assert.equal(workerAConfirmRes.body.ok, false);
  if (!workerAConfirmRes.body.ok) {
    assert.equal(workerAConfirmRes.body.error.code, "STALE_FENCING_TOKEN");
    assert.equal(workerAConfirmRes.body.error.details?.incoming_fencing_token, 1);
    assert.equal(workerAConfirmRes.body.error.details?.last_accepted_fencing_token, 2);
  }

  const confirmedList = confirmRepo.getConfirmedReservations();
  assert.equal(confirmedList.length, 1, "Only Worker B's reservation with newer fencingToken may be confirmed");
  assert.equal(confirmedList[0]?.bookingId, "erb_fence_confirm_b");
  assert.equal(confirmedList[0]?.fencingToken, 2);
  assert.equal(confirmIdempotencyStore.getStatus(workerAReq.idempotencyKey), null);
  assert.equal(confirmLockManager.getActiveLockCount(), 0);

  // 5c. Direct ReservationRepository validation check for stale fencingToken on confirmHold
  const directRepo = new InMemoryReservationRepository(1);
  const directHold = await directRepo.createPendingHold({
    bookingId: "erb_direct_1",
    vehicleId: "car_direct_01",
    customerId: "cust_direct_1",
    fencingToken: 5,
  });
  await assert.rejects(
    () => directRepo.confirmHold(directHold.reservationId, "cap_stale_direct", 4),
    (err: unknown) =>
      err instanceof ReservationConflictError && err.code === "STALE_FENCING_TOKEN"
  );

  console.log(
    "  PASS: ReservationStore rejected stale writes (incomingToken < lastAcceptedToken) with 409 STALE_FENCING_TOKEN on both createPendingHold and confirmHold."
  );
}

async function main(): Promise<void> {
  console.log("Running Easy Rent Bali Checkout Concurrency & Idempotency Verification Suite...");
  await testSameIdempotencyKeyRetryStorm();
  await testDistinctKeysVehicleLockContention();
  await testPaymentFailureCompensation();
  await testUnhandledExceptionIdempotencyCleanup();
  await testMonotonicFencingTokenValidation();
  console.log("\nALL CONCURRENCY TESTS PASSED.");
}

main().catch((err) => {
  console.error("\nCONCURRENCY TEST SUITE FAILED:", err);
  process.exitCode = 1;
});
