import { readFile } from "node:fs/promises";
import path from "node:path";

// ============================================================================
// Domain Types & Thresholds
// ============================================================================

export type VehicleRentalStatus = "rented" | "available";

export interface TelemetryRecord {
  device_id: string;
  plate: string;
  model: string;
  status: VehicleRentalStatus;
  current_speed_kmh: number;
  current_location: {
    zone: string;
  };
  battery_voltage: number;
  fuel_percent: number;
  last_ping_seconds_ago: number;
  gateway_id: string;
}

export type IncidentFlag =
  | "CRITICAL_SECURITY_ALERT"
  | "OFFLINE_TELEMETRY_DROP"
  | "MAINTENANCE_REQUIRED";

export type IncidentSeverity = "CRITICAL" | "HIGH" | "MEDIUM";

export interface IncidentTrigger {
  flag: IncidentFlag;
  severity: IncidentSeverity;
  rule: string;
  detail: string;
  recommended_action: string;
}

export interface TriagedVehicleIncident {
  incident_id: string;
  device_id: string;
  plate: string;
  model: string;
  status: VehicleRentalStatus;
  gateway_id: string;
  zone: string;
  flags: IncidentFlag[];
  highest_severity: IncidentSeverity;
  triggers: IncidentTrigger[];
  telemetry_snapshot: {
    current_speed_kmh: number;
    battery_voltage: number;
    fuel_percent: number;
    last_ping_seconds_ago: number;
  };
  detected_at: string;
}

export interface HealthyVehicleSummary {
  device_id: string;
  plate: string;
  model: string;
  status: VehicleRentalStatus;
  zone: string;
  gateway_id: string;
}

export interface TriageResult {
  source_file: string;
  evaluated_at: string;
  total_vehicles: number;
  healthy_vehicles: HealthyVehicleSummary[];
  incidents: TriagedVehicleIncident[];
  counts_by_flag: Record<IncidentFlag, number>;
  counts_by_severity: Record<IncidentSeverity, number>;
}

export const TRIAGE_THRESHOLDS = {
  OFFLINE_SILENT_THRESHOLD_SECONDS: 900, // 15 minutes
  LOW_BATTERY_VOLTAGE_THRESHOLD: 11.5,
  LOW_FUEL_PERCENT_THRESHOLD: 15,
  RESTRICTED_ZONE_KEYWORD: "RESTRICTED",
} as const;

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  CRITICAL: 3,
  HIGH: 2,
  MEDIUM: 1,
};

// ============================================================================
// Core Triage Evaluation Logic (Multi-Flag Capable)
// ============================================================================

/**
 * Evaluates a single vehicle telemetry record against all fleet security,
 * connectivity, and maintenance rules independently so a vehicle can carry
 * multiple flags simultaneously.
 */
export function evaluateVehicleTelemetry(
  record: TelemetryRecord,
  detectedAt = new Date().toISOString()
): TriagedVehicleIncident | null {
  const triggers: IncidentTrigger[] = [];
  const flagSet = new Set<IncidentFlag>();
  const normalizedZone = record.current_location.zone.trim().toUpperCase();

  // Rule 1: CRITICAL_SECURITY_ALERT
  // Condition 1a: Available (unrented) vehicle moving > 0 km/h
  if (record.status === "available" && record.current_speed_kmh > 0) {
    flagSet.add("CRITICAL_SECURITY_ALERT");
    triggers.push({
      flag: "CRITICAL_SECURITY_ALERT",
      severity: "CRITICAL",
      rule: "AVAILABLE_VEHICLE_IN_MOTION",
      detail: `Unrented (available) vehicle ${record.plate} is moving at ${record.current_speed_kmh} km/h in zone ${record.current_location.zone}.`,
      recommended_action:
        "Verify unauthorized movement immediately, alert Kuta Hub security, and prepare remote immobilizer check.",
    });
  }

  // Condition 1b: Vehicle entered a RESTRICTED zone
  if (normalizedZone.includes(TRIAGE_THRESHOLDS.RESTRICTED_ZONE_KEYWORD)) {
    flagSet.add("CRITICAL_SECURITY_ALERT");
    triggers.push({
      flag: "CRITICAL_SECURITY_ALERT",
      severity: "CRITICAL",
      rule: "RESTRICTED_GEOFENCE_BREACH",
      detail: `Vehicle ${record.plate} entered restricted zone '${record.current_location.zone}' at ${record.current_speed_kmh} km/h.`,
      recommended_action:
        "Contact renter immediately regarding geofence violation and notify operations security team.",
    });
  }

  // Rule 2: OFFLINE_TELEMETRY_DROP
  // Condition: Rented vehicle silent for > 15 minutes (900 seconds)
  if (
    record.status === "rented" &&
    record.last_ping_seconds_ago > TRIAGE_THRESHOLDS.OFFLINE_SILENT_THRESHOLD_SECONDS
  ) {
    flagSet.add("OFFLINE_TELEMETRY_DROP");
    const silentMinutes = Number((record.last_ping_seconds_ago / 60).toFixed(1));
    triggers.push({
      flag: "OFFLINE_TELEMETRY_DROP",
      severity: "HIGH",
      rule: "RENTED_TELEMETRY_SILENT_OVER_15M",
      detail: `Rented vehicle ${record.plate} has been silent for ${record.last_ping_seconds_ago}s (${silentMinutes} min > 15 min threshold) via gateway '${record.gateway_id}'.`,
      recommended_action:
        "Trigger SMS/cellular fallback ping, inspect gateway health, and verify GPS tracker power status.",
    });
  }

  // Rule 3: MAINTENANCE_REQUIRED
  // Condition 3a: Battery voltage < 11.5V
  if (record.battery_voltage < TRIAGE_THRESHOLDS.LOW_BATTERY_VOLTAGE_THRESHOLD) {
    flagSet.add("MAINTENANCE_REQUIRED");
    triggers.push({
      flag: "MAINTENANCE_REQUIRED",
      severity: "MEDIUM",
      rule: "LOW_BATTERY_VOLTAGE",
      detail: `Vehicle ${record.plate} battery voltage dropped to ${record.battery_voltage}V (threshold < ${TRIAGE_THRESHOLDS.LOW_BATTERY_VOLTAGE_THRESHOLD}V).`,
      recommended_action:
        "Dispatch mobile roadside technician for battery/alternator inspection before vehicle stalls.",
    });
  }

  // Condition 3b: Fuel level < 15%
  if (record.fuel_percent < TRIAGE_THRESHOLDS.LOW_FUEL_PERCENT_THRESHOLD) {
    flagSet.add("MAINTENANCE_REQUIRED");
    triggers.push({
      flag: "MAINTENANCE_REQUIRED",
      severity: "MEDIUM",
      rule: "LOW_FUEL_LEVEL",
      detail: `Vehicle ${record.plate} fuel level is critically low at ${record.fuel_percent}% (threshold < ${TRIAGE_THRESHOLDS.LOW_FUEL_PERCENT_THRESHOLD}%).`,
      recommended_action:
        record.status === "available"
          ? "Hold vehicle from dispatch until Kuta Hub crew completes refueling."
          : "Send automated low-fuel advisory to renter and schedule hub refueling upon return.",
    });
  }

  if (triggers.length === 0) {
    return null;
  }

  const flags = [...flagSet];
  const highestSeverity = triggers.reduce<IncidentSeverity>(
    (highest, current) =>
      SEVERITY_RANK[current.severity] > SEVERITY_RANK[highest] ? current.severity : highest,
    "MEDIUM"
  );

  return {
    incident_id: `inc_${record.device_id}_${flags.map((f) => f.slice(0, 3).toLowerCase()).join("_")}`,
    device_id: record.device_id,
    plate: record.plate,
    model: record.model,
    status: record.status,
    gateway_id: record.gateway_id,
    zone: record.current_location.zone,
    flags,
    highest_severity: highestSeverity,
    triggers,
    telemetry_snapshot: {
      current_speed_kmh: record.current_speed_kmh,
      battery_voltage: record.battery_voltage,
      fuel_percent: record.fuel_percent,
      last_ping_seconds_ago: record.last_ping_seconds_ago,
    },
    detected_at: detectedAt,
  };
}

/**
 * Evaluates a full batch of telemetry records and produces prioritized incidents
 * plus aggregate flag/severity metrics.
 */
export function triageFleetTelemetry(
  records: TelemetryRecord[],
  sourceFile = "in-memory",
  evaluatedAt = new Date().toISOString()
): TriageResult {
  const incidents: TriagedVehicleIncident[] = [];
  const healthyVehicles: HealthyVehicleSummary[] = [];

  const countsByFlag: Record<IncidentFlag, number> = {
    CRITICAL_SECURITY_ALERT: 0,
    OFFLINE_TELEMETRY_DROP: 0,
    MAINTENANCE_REQUIRED: 0,
  };

  const countsBySeverity: Record<IncidentSeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
  };

  for (const record of records) {
    const incident = evaluateVehicleTelemetry(record, evaluatedAt);
    if (!incident) {
      healthyVehicles.push({
        device_id: record.device_id,
        plate: record.plate,
        model: record.model,
        status: record.status,
        zone: record.current_location.zone,
        gateway_id: record.gateway_id,
      });
      continue;
    }

    incidents.push(incident);
    countsBySeverity[incident.highest_severity]++;
    for (const flag of incident.flags) {
      countsByFlag[flag]++;
    }
  }

  // Sort incidents so CRITICAL security alerts are dispatched before HIGH and MEDIUM
  incidents.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.highest_severity] - SEVERITY_RANK[a.highest_severity];
    if (rankDiff !== 0) return rankDiff;
    return a.device_id.localeCompare(b.device_id);
  });

  return {
    source_file: sourceFile,
    evaluated_at: evaluatedAt,
    total_vehicles: records.length,
    healthy_vehicles: healthyVehicles,
    incidents,
    counts_by_flag: countsByFlag,
    counts_by_severity: countsBySeverity,
  };
}

export async function loadTelemetryFromFile(filePath: string): Promise<TelemetryRecord[]> {
  const raw = await readFile(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected telemetry JSON array in '${filePath}'.`);
  }

  return parsed as TelemetryRecord[];
}

export async function runTriageFromFile(
  filePath = path.resolve(process.cwd(), "data", "outage_telemetry.json")
): Promise<TriageResult> {
  const records = await loadTelemetryFromFile(filePath);
  const relativeSource = path.relative(process.cwd(), filePath).replaceAll("\\", "/");
  return triageFleetTelemetry(records, relativeSource);
}
