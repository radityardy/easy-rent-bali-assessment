import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRIAGE_THRESHOLDS,
  runTriageFromFile,
  type HealthyVehicleSummary,
  type IncidentFlag,
  type IncidentSeverity,
  type IncidentTrigger,
  type TriagedVehicleIncident,
} from "./triage_engine.js";

// ============================================================================
// Structured Alert Payload & Dispatch Contracts
// ============================================================================

export interface StructuredAlertPayload {
  schema_version: "1.0";
  alert_id: string;
  idempotency_key: string;
  timestamp: string;
  severity: IncidentSeverity;
  flags: IncidentFlag[];
  routing_channels: string[];
  summary: string;
  vehicle: {
    device_id: string;
    plate: string;
    model: string;
    status: TriagedVehicleIncident["status"];
    gateway_id: string;
    zone: string;
  };
  telemetry: TriagedVehicleIncident["telemetry_snapshot"];
  triggers: IncidentTrigger[];
  recommended_actions: string[];
}

export interface DispatchAttemptLog {
  attempt: number;
  timestamp: string;
  outcome: "DELIVERED" | "TRANSIENT_FAILURE";
  http_status: number;
  error?: string;
  backoff_cap_ms?: number;
  jittered_delay_ms?: number;
}

export interface DispatchResult {
  alert_id: string;
  incident_id: string;
  device_id: string;
  idempotency_key: string;
  status: "DELIVERED" | "DEAD_LETTERED";
  attempts_made: number;
  retries_performed: number;
  total_backoff_ms: number;
  delivered_at?: string;
  final_error?: string;
  attempt_history: DispatchAttemptLog[];
}

export interface ReconciledIncidentEntry {
  incident: TriagedVehicleIncident;
  alert_payload: StructuredAlertPayload;
  dispatch_result: DispatchResult;
}

export interface IncidentReconciliationReport {
  reconciliation_id: string;
  generated_at: string;
  source_telemetry_file: string;
  engine_config: {
    thresholds: typeof TRIAGE_THRESHOLDS;
    dispatcher: {
      packet_loss_rate: number;
      max_retries: number;
      backoff_strategy: "exponential_backoff_full_jitter";
      base_delay_ms: number;
      max_delay_ms: number;
    };
  };
  summary: {
    total_vehicles_scanned: number;
    healthy_vehicles_count: number;
    flagged_vehicles_count: number;
    multi_flag_vehicles_count: number;
    incidents_by_flag: Record<IncidentFlag, number>;
    incidents_by_severity: Record<IncidentSeverity, number>;
    dispatch_stats: {
      total_alerts: number;
      delivered_count: number;
      dead_lettered_count: number;
      total_transmission_attempts: number;
      total_transient_failures: number;
      observed_packet_loss_rate: number;
    };
  };
  healthy_vehicles: HealthyVehicleSummary[];
  reconciled_incidents: ReconciledIncidentEntry[];
  dead_letter_queue: ReconciledIncidentEntry[];
}

export interface DispatcherOptions {
  /** Simulated transient packet loss probability in [0, 1]. Default: 0.18 (18%). */
  packetLossRate?: number;
  /** Maximum retry count after the initial transmission attempt. Default: 5. */
  maxRetries?: number;
  /** Base exponential backoff delay in ms. Default: 100ms. */
  baseDelayMs?: number;
  /** Maximum exponential backoff cap in ms. Default: 3200ms. */
  maxDelayMs?: number;
  /** Optional deterministic RNG for testing. Defaults to Math.random. */
  rng?: () => number;
  /** Optional custom sleep implementation. */
  sleep?: (ms: number) => Promise<void>;
}

const FLAG_CHANNELS: Record<IncidentFlag, string[]> = {
  CRITICAL_SECURITY_ALERT: ["pagerduty-security-p1", "whatsapp-kuta-hub-security"],
  OFFLINE_TELEMETRY_DROP: ["slack-fleet-noc", "network-self-healing-queue"],
  MAINTENANCE_REQUIRED: ["ops-fleet-maintenance"],
};

// ============================================================================
// Alert Formatting & Exponential Backoff + Full Jitter Helpers
// ============================================================================

export function formatAlertPayload(incident: TriagedVehicleIncident): StructuredAlertPayload {
  const channelSet = new Set<string>();
  for (const flag of incident.flags) {
    for (const channel of FLAG_CHANNELS[flag]) {
      channelSet.add(channel);
    }
  }

  const recommendedActions = [...new Set(incident.triggers.map((t) => t.recommended_action))];
  const ruleNames = incident.triggers.map((t) => t.rule).join(", ");

  return {
    schema_version: "1.0",
    alert_id: `alrt_${randomUUID().slice(0, 8)}`,
    idempotency_key: `dispatch:${incident.incident_id}:${incident.flags.join("+")}`,
    timestamp: incident.detected_at,
    severity: incident.highest_severity,
    flags: [...incident.flags],
    routing_channels: [...channelSet],
    summary: `[${incident.highest_severity}] ${incident.plate} (${incident.model}) — ${incident.flags.join(" + ")} (${ruleNames})`,
    vehicle: {
      device_id: incident.device_id,
      plate: incident.plate,
      model: incident.model,
      status: incident.status,
      gateway_id: incident.gateway_id,
      zone: incident.zone,
    },
    telemetry: { ...incident.telemetry_snapshot },
    triggers: incident.triggers.map((t) => ({ ...t })),
    recommended_actions: recommendedActions,
  };
}

/**
 * Computes AWS-style Full Jitter exponential backoff:
 *   cap = min(maxDelayMs, baseDelayMs * 2^(attempt - 1))
 *   delay = floor(random() * cap)
 */
export function computeFullJitterBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  rng: () => number = Math.random
): { backoffCapMs: number; jitteredDelayMs: number } {
  const backoffCapMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitteredDelayMs = Math.floor(rng() * backoffCapMs);
  return { backoffCapMs, jitteredDelayMs };
}

// ============================================================================
// Self-Healing Alert Dispatcher
// ============================================================================

export class AlertDispatcher {
  public readonly packetLossRate: number;
  public readonly maxRetries: number;
  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  private readonly rng: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: DispatcherOptions = {}) {
    this.packetLossRate = options.packetLossRate ?? 0.18;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 3_200;
    this.rng = options.rng ?? Math.random;
    this.sleepFn = options.sleep ?? defaultSleep;
  }

  /**
   * Simulates transmitting a structured alert payload across an unreliable
   * mobile/gateway link with configurable transient packet loss.
   */
  private async transmitOnce(payload: StructuredAlertPayload): Promise<{ ok: true } | { ok: false; error: string }> {
    // Small simulated network RTT (5-15ms)
    await this.sleepFn(5);

    if (this.rng() < this.packetLossRate) {
      return {
        ok: false,
        error: `TRANSIENT_PACKET_LOSS: Gateway '${payload.vehicle.gateway_id}' dropped alert packet '${payload.alert_id}' (18% simulated loss).`,
      };
    }

    return { ok: true };
  }

  /**
   * Dispatches a structured alert with Exponential Backoff + Full Jitter retry.
   */
  async dispatchAlert(
    incident: TriagedVehicleIncident,
    payload: StructuredAlertPayload
  ): Promise<DispatchResult> {
    const attemptHistory: DispatchAttemptLog[] = [];
    const maxAttempts = this.maxRetries + 1;
    let totalBackoffMs = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptTimestamp = new Date().toISOString();
      const transmission = await this.transmitOnce(payload);

      if (transmission.ok) {
        attemptHistory.push({
          attempt,
          timestamp: attemptTimestamp,
          outcome: "DELIVERED",
          http_status: 202,
        });

        return {
          alert_id: payload.alert_id,
          incident_id: incident.incident_id,
          device_id: incident.device_id,
          idempotency_key: payload.idempotency_key,
          status: "DELIVERED",
          attempts_made: attempt,
          retries_performed: attempt - 1,
          total_backoff_ms: totalBackoffMs,
          delivered_at: attemptTimestamp,
          attempt_history: attemptHistory,
        };
      }

      const isFinalAttempt = attempt === maxAttempts;
      if (isFinalAttempt) {
        attemptHistory.push({
          attempt,
          timestamp: attemptTimestamp,
          outcome: "TRANSIENT_FAILURE",
          http_status: 503,
          error: transmission.error,
        });

        return {
          alert_id: payload.alert_id,
          incident_id: incident.incident_id,
          device_id: incident.device_id,
          idempotency_key: payload.idempotency_key,
          status: "DEAD_LETTERED",
          attempts_made: attempt,
          retries_performed: attempt - 1,
          total_backoff_ms: totalBackoffMs,
          final_error: transmission.error,
          attempt_history: attemptHistory,
        };
      }

      const { backoffCapMs, jitteredDelayMs } = computeFullJitterBackoff(
        attempt,
        this.baseDelayMs,
        this.maxDelayMs,
        this.rng
      );

      attemptHistory.push({
        attempt,
        timestamp: attemptTimestamp,
        outcome: "TRANSIENT_FAILURE",
        http_status: 503,
        error: transmission.error,
        backoff_cap_ms: backoffCapMs,
        jittered_delay_ms: jitteredDelayMs,
      });

      totalBackoffMs += jitteredDelayMs;
      await this.sleepFn(jitteredDelayMs);
    }

    // Unreachable due to loop bounds, retained for exhaustiveness
    throw new Error(`Unexpected dispatch termination for incident '${incident.incident_id}'.`);
  }
}

// ============================================================================
// End-to-End Self-Healing Fleet Engine Runner & Reconciliation Exporter
// ============================================================================

export async function runSelfHealingEngine(params?: {
  telemetryPath?: string;
  outputPath?: string;
  dispatcherOptions?: DispatcherOptions;
}): Promise<IncidentReconciliationReport> {
  const telemetryPath =
    params?.telemetryPath ?? path.resolve(process.cwd(), "data", "outage_telemetry.json");
  const outputPath =
    params?.outputPath ?? path.resolve(process.cwd(), "output", "incident_reconciliation.json");

  const triageResult = await runTriageFromFile(telemetryPath);
  const dispatcher = new AlertDispatcher(params?.dispatcherOptions);

  const reconciledIncidents: ReconciledIncidentEntry[] = [];
  for (const incident of triageResult.incidents) {
    const alertPayload = formatAlertPayload(incident);
    const dispatchResult = await dispatcher.dispatchAlert(incident, alertPayload);
    reconciledIncidents.push({
      incident,
      alert_payload: alertPayload,
      dispatch_result: dispatchResult,
    });
  }

  const deadLetterQueue = reconciledIncidents.filter(
    (entry) => entry.dispatch_result.status === "DEAD_LETTERED"
  );

  const totalAttempts = reconciledIncidents.reduce(
    (sum, entry) => sum + entry.dispatch_result.attempts_made,
    0
  );
  const totalTransientFailures = reconciledIncidents.reduce(
    (sum, entry) =>
      sum + entry.dispatch_result.attempt_history.filter((a) => a.outcome === "TRANSIENT_FAILURE").length,
    0
  );
  const multiFlagCount = triageResult.incidents.filter((inc) => inc.flags.length > 1).length;

  const report: IncidentReconciliationReport = {
    reconciliation_id: `recon_${randomUUID().slice(0, 8)}`,
    generated_at: new Date().toISOString(),
    source_telemetry_file: triageResult.source_file,
    engine_config: {
      thresholds: TRIAGE_THRESHOLDS,
      dispatcher: {
        packet_loss_rate: dispatcher.packetLossRate,
        max_retries: dispatcher.maxRetries,
        backoff_strategy: "exponential_backoff_full_jitter",
        base_delay_ms: dispatcher.baseDelayMs,
        max_delay_ms: dispatcher.maxDelayMs,
      },
    },
    summary: {
      total_vehicles_scanned: triageResult.total_vehicles,
      healthy_vehicles_count: triageResult.healthy_vehicles.length,
      flagged_vehicles_count: triageResult.incidents.length,
      multi_flag_vehicles_count: multiFlagCount,
      incidents_by_flag: triageResult.counts_by_flag,
      incidents_by_severity: triageResult.counts_by_severity,
      dispatch_stats: {
        total_alerts: reconciledIncidents.length,
        delivered_count: reconciledIncidents.length - deadLetterQueue.length,
        dead_lettered_count: deadLetterQueue.length,
        total_transmission_attempts: totalAttempts,
        total_transient_failures: totalTransientFailures,
        observed_packet_loss_rate:
          totalAttempts > 0 ? Number((totalTransientFailures / totalAttempts).toFixed(4)) : 0,
      },
    },
    healthy_vehicles: triageResult.healthy_vehicles,
    reconciled_incidents: reconciledIncidents,
    dead_letter_queue: deadLetterQueue,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  return report;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// CLI Entrypoint (`npm run engine:run`)
// ============================================================================

async function main(): Promise<void> {
  const outputPath = path.resolve(process.cwd(), "output", "incident_reconciliation.json");
  console.log("Starting Easy Rent Bali Real-Time Fleet & Network Self-Healing Engine...");

  const report = await runSelfHealingEngine({ outputPath });

  console.log(`\nScanned ${report.summary.total_vehicles_scanned} vehicles from ${report.source_telemetry_file}:`);
  console.log(
    `  Flagged: ${report.summary.flagged_vehicles_count} | Healthy: ${report.summary.healthy_vehicles_count} | Multi-flag: ${report.summary.multi_flag_vehicles_count}`
  );
  console.log(
    `  By Flag: CRITICAL_SECURITY_ALERT=${report.summary.incidents_by_flag.CRITICAL_SECURITY_ALERT}, OFFLINE_TELEMETRY_DROP=${report.summary.incidents_by_flag.OFFLINE_TELEMETRY_DROP}, MAINTENANCE_REQUIRED=${report.summary.incidents_by_flag.MAINTENANCE_REQUIRED}`
  );

  console.log("\nDispatched Alerts (Exponential Backoff + Full Jitter, 18% Packet Loss Simulation):");
  for (const entry of report.reconciled_incidents) {
    const { incident, dispatch_result: dr } = entry;
    console.log(
      `  [${incident.highest_severity}] ${incident.device_id} (${incident.plate}) | flags=${incident.flags.join(",")} | status=${dr.status} | attempts=${dr.attempts_made} | retries=${dr.retries_performed} | backoff=${dr.total_backoff_ms}ms`
    );
  }

  console.log(
    `\nDispatch Summary: delivered=${report.summary.dispatch_stats.delivered_count}/${report.summary.dispatch_stats.total_alerts}, dead_lettered=${report.summary.dispatch_stats.dead_lettered_count}, total_attempts=${report.summary.dispatch_stats.total_transmission_attempts}, transient_failures=${report.summary.dispatch_stats.total_transient_failures}`
  );
  console.log(`Reconciliation report exported to: ${path.relative(process.cwd(), outputPath).replaceAll("\\", "/")}`);
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Self-Healing Engine failed:", err);
    process.exitCode = 1;
  });
}
