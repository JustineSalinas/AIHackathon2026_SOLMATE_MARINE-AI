// GENERATED FILE -- DO NOT EDIT.
//
// Emitted from the Pydantic contracts by:
//     python -m packages.contracts.export_schema
//
// The Python models in packages/contracts and apps/api are the single
// source of truth. Change them and re-run; never hand-edit this file.
// Generated from commit 295166c.

export interface AnomalyStream {
  /** Field path, e.g. 'electro_mechanical.coolant_temp_c'. */
  stream: string;
  /** Plain language. 'Engine coolant temperature', not the path. */
  label_en: string;
  label_fil: string;
  /** PCA reconstruction residual for this stream -- a linear autoencoder's error. See docs/DEVIATIONS.md for why PCA, not a deep net. */
  reconstruction_error: number;
  /** Deviation from the learned baseline, in sigmas. */
  z_score: number;
  /** Share of the total anomaly score. Ranks the strip on the display. */
  contribution_pct: number;
  /** How long this stream has been deviating. Drift reads differently from a spike. */
  trend_minutes?: number | null;
}

export type BaselineMethod = "own_prior_route" | "counterfactual_model" | "none";

export type Connectivity = "online" | "degraded" | "offline";

export interface CurvePoint {
  speed_kn: number;
  rpm: number;
  shaft_kw: number;
  litres_per_hour: number;
}

export interface DutyCycleSummary {
  /** Engine-running hours integrated in THIS window. Not a lifetime total. */
  running_hours: number;
  /** Running hours per load band within this window, keyed by band name. */
  hours_by_band: Record<string, number>;
  /** Weighted wear-hours per running hour. 1.0 is a window spent at cruise; above 1.0 is harder use. A rate, so it is window-length independent. */
  severity_index: number;
  /** Wear-equivalent hours for this window: running hours x band weight. */
  weighted_hours: number;
  /** Band with the most hours; ties break toward harder. */
  dominant_band: string;
  dominant_label_en: string;
  dominant_label_fil: string;
}

export interface ElectroMechanicalFrame {
  coolant_temp_c?: number | null;
  oil_pressure_kpa?: number | null;
  battery_voltage_v?: number | null;
  accel_x_g?: number | null;
  accel_y_g?: number | null;
  accel_z_g?: number | null;
  gyro_x_dps?: number | null;
  gyro_y_dps?: number | null;
  gyro_z_dps?: number | null;
  exhaust_co2_pct?: number | null;
  exhaust_nox_ppm?: number | null;
  oil_particulate_ppm?: number | null;
  exhaust_gas_temp_c?: number | null;
  /** Cumulative run-hours. The denominator of every RUL calculation. */
  engine_hours?: number | null;
}

export interface EmissionsOut {
  co2_kg_per_hour: number;
  co2_kg_per_nm?: number | null;
}

export interface EmissionsReportLine {
  voyage_id: string;
  departed_at: string;
  route: string;
  distance_nm: number;
  fuel_used_l: number;
  co2_kg: number;
  baseline_fuel_l?: number | null;
  co2_avoided_kg?: number | null;
  baseline_method: BaselineMethod;
}

export type HullType = "fiberglass_monohull" | "fiberglass_outrigger" | "steel_monohull";

export interface LatLonInput {
  latitude: number;
  longitude: number;
  name?: string | null;
}

export type MaintenancePhase = "phase_1_cold_start" | "phase_2_mature";

export interface MaintenanceStatus {
  vessel_id: string;
  generated_at: string;
  phase: MaintenancePhase;
  /** 0 nominal, 1 strongly anomalous. Ensemble of a robust per-stream z-score and a PCA reconstruction error; see docs/DEVIATIONS.md. */
  anomaly_score: number;
  is_anomalous: boolean;
  /** Ranked by contribution_pct, descending. */
  streams?: AnomalyStream[] | null;
  /** Run-hours of history behind this model. Drives the phase transition. */
  observed_hours: number;
  /** How well-established this vessel's normal is. Low early in Phase 1. */
  baseline_confidence: number;
  /** Engine exposure over this window. None when the caller did not supply a rated RPM, since load is meaningless without a rating to divide by. */
  duty?: DutyCycleSummary | null;
  likely_component?: string | null;
  likely_component_fil?: string | null;
  recommended_maintenance_date?: string | null;
  remaining_useful_life_days?: number | null;
  rul_confidence_interval_days?: unknown[] | null;
  required_parts?: string[] | null;
  estimated_downtime_hours?: number | null;
  advisory_en: string;
  advisory_fil: string;
  advisory_source?: string | null;
}

export interface ModuleStatus_MaintenanceStatus_ {
  state: "ok" | "stale" | "error" | "unavailable";
  data?: MaintenanceStatus | null;
  generated_at?: string | null;
  /** Rendered verbatim on the display. Never hide the age of advice. */
  age_seconds?: number | null;
  /** True for maintenance and safety, false for speed and route. Explains to the captain why one panel is live while another is frozen. */
  computed_at_edge: boolean;
  /** Plain language, shown to the captain. Not a stack trace. */
  error?: string | null;
}

export interface ModuleStatus_RouteRecommendation_ {
  state: "ok" | "stale" | "error" | "unavailable";
  data?: RouteRecommendation | null;
  generated_at?: string | null;
  /** Rendered verbatim on the display. Never hide the age of advice. */
  age_seconds?: number | null;
  /** True for maintenance and safety, false for speed and route. Explains to the captain why one panel is live while another is frozen. */
  computed_at_edge: boolean;
  /** Plain language, shown to the captain. Not a stack trace. */
  error?: string | null;
}

export interface ModuleStatus_SafetyState_ {
  state: "ok" | "stale" | "error" | "unavailable";
  data?: SafetyState | null;
  generated_at?: string | null;
  /** Rendered verbatim on the display. Never hide the age of advice. */
  age_seconds?: number | null;
  /** True for maintenance and safety, false for speed and route. Explains to the captain why one panel is live while another is frozen. */
  computed_at_edge: boolean;
  /** Plain language, shown to the captain. Not a stack trace. */
  error?: string | null;
}

export interface ModuleStatus_SpeedRecommendation_ {
  state: "ok" | "stale" | "error" | "unavailable";
  data?: SpeedRecommendation | null;
  generated_at?: string | null;
  /** Rendered verbatim on the display. Never hide the age of advice. */
  age_seconds?: number | null;
  /** True for maintenance and safety, false for speed and route. Explains to the captain why one panel is live while another is frozen. */
  computed_at_edge: boolean;
  /** Plain language, shown to the captain. Not a stack trace. */
  error?: string | null;
}

export interface OperatorContext {
  passenger_count?: number | null;
  cargo_estimate_kg?: number | null;
  /** The ETA constraint the route optimizer must respect. */
  scheduled_arrival?: string | null;
}

export interface PowerOut {
  total_kw: number;
  calm_water_kw: number;
  wind_kw: number;
  wave_kw: number;
  speed_through_water_kn: number;
  environmental_penalty_pct: number;
}

export interface RouteRecommendation {
  vessel_id: string;
  voyage_id?: string | null;
  generated_at: string;
  waypoints: Waypoint[];
  total_distance_nm: number;
  eta: string;
  /** Crossing time the hull can actually achieve, summed from each leg's optimised speed. Always populated where a speed was found. When a schedule was requested, `eta` is the arrival that was ASKED FOR -- legs are planned at the required speed-over-ground -- so where schedule_feasible is False the two differ and THIS is the honest one. None only when some leg admits no forward speed at all, where a crossing time does not exist rather than being very large. */
  achievable_minutes?: number | null;
  /** Whole-route burn, same fuel model as Speed. */
  predicted_burn_l: number;
  /** Great-circle direct route -- what the captain would otherwise steer. */
  baseline_distance_nm?: number | null;
  baseline_burn_l?: number | null;
  /** baseline_burn_l - predicted_burn_l. May be negative; show it honestly. */
  savings_l?: number | null;
  /** True if a shallower, shorter route was rejected on depth. */
  depth_constrained?: boolean | null;
  /** True if a route was rejected on forecast wave height. */
  weather_constrained?: boolean | null;
  constraint_notes?: string[] | null;
  /** 'tft' or 'gbm_fallback'. Recorded so the deck and the code agree. */
  forecast_source?: string | null;
  model_confidence: number;
  advisory_en: string;
  advisory_fil: string;
  advisory_source?: string | null;
}

export interface RoutingFrame {
  latitude?: number | null;
  longitude?: number | null;
  heading_deg?: number | null;
  speed_over_ground_kn?: number | null;
  /** Under-keel depth. Hard safety constraint on any route. */
  depth_m?: number | null;
  wave_height_m?: number | null;
  nearby_vessel_count?: number | null;
}

export interface SafetyCutoff {
  /** Stable identifier, e.g. 'coolant_overtemp'. Cited in logs. */
  rule_id: string;
  severity: Severity;
  /** Field path the rule watches. */
  stream: string;
  label_en: string;
  label_fil: string;
  observed: number;
  threshold: number;
  unit: string;
  message_en: string;
  message_fil: string;
  triggered_at: string;
}

export interface SafetyState {
  vessel_id: string;
  generated_at: string;
  /** Highest severity among active cutoffs. */
  severity: Severity;
  active?: SafetyCutoff[] | null;
  /** How many rules ran. Distinguishes 'all clear' from 'no data to check'. */
  evaluated_rules: number;
  /** Rules skipped because their sensor was absent. A modular retrofit may lack a channel; silence about that would be dishonest. */
  skipped_rules?: string[] | null;
}

export interface SeaInput {
  wind_speed_kn?: number | null;
  wind_direction_deg?: number | null;
  current_speed_kn?: number | null;
  current_direction_deg?: number | null;
  wave_height_m?: number | null;
  wave_direction_deg?: number | null;
}

export type Severity = "nominal" | "warning" | "critical";

export interface SpeedRecommendation {
  vessel_id: string;
  generated_at: string;
  /** The setting the captain should move to. */
  recommended_rpm: number;
  /** Expected speed through water at that RPM. */
  recommended_speed_kn: number;
  current_rpm?: number | null;
  /** Model estimate at current RPM. */
  current_burn_lph?: number | null;
  /** Model estimate at recommended RPM. */
  predicted_burn_lph: number;
  /** current_burn_lph - predicted_burn_lph. Negative means the captain is already more efficient than the recommendation; show it honestly. */
  savings_lph: number;
  /** savings_lph * diesel price. Operators budget in pesos, not litres. */
  savings_php_per_hour?: number | null;
  /** Widens as inputs drift from the training distribution. */
  model_confidence: number;
  /** Change in arrival time if the recommendation is followed. Near zero by construction -- the optimizer holds ETA and minimises burn. */
  eta_impact_minutes: number;
  advisory_en: string;
  advisory_fil: string;
  /** 'claude' or 'template'. The display never blocks on the API; if Claude is slow or down, the deterministic template ships instead. */
  advisory_source?: string | null;
}

export interface TelemetryFrame {
  vessel_id: string;
  /** Timezone-aware UTC. Validated on ingest. */
  ts: string;
  voyage_id?: string | null;
  throttling?: ThrottlingFrame | null;
  routing?: RoutingFrame | null;
  electro_mechanical?: ElectroMechanicalFrame | null;
  operator?: OperatorContext | null;
  /** Provenance. 'simulator' for every frame in the hackathon build -- no hardware was used. Never silently defaults to 'sensor'. */
  source?: string | null;
}

export interface ThrottlingFrame {
  /** Tank remaining, litres */
  fuel_level_l?: number | null;
  engine_rpm?: number | null;
  /** Ground truth burn rate. Trains and validates the fuel model. */
  fuel_flow_lph?: number | null;
  /** Actual captain input. Closes the advice/action feedback loop. */
  throttle_position_pct?: number | null;
  /** Stronger fuel-burn predictor than RPM alone. */
  engine_torque_nm?: number | null;
  /** Differenced against GPS ground speed to isolate current. */
  speed_through_water_kn?: number | null;
  wind_speed_kn?: number | null;
  /** Direction wind is coming FROM. */
  wind_direction_deg?: number | null;
  current_speed_kn?: number | null;
  /** Direction current is flowing TOWARD. */
  current_direction_deg?: number | null;
  tide_level_m?: number | null;
}

export interface VesselInput {
  vessel_id?: string | null;
  length_waterline_m?: number | null;
  beam_m?: number | null;
  draft_m?: number | null;
  displacement_kg?: number | null;
  rated_kw?: number | null;
  rated_rpm?: number | null;
  /** Primary calibration handle; fit per vessel from its own runs. */
  admiralty_coefficient?: number | null;
  best_bsfc_g_per_kwh?: number | null;
  idle_burn_lph?: number | null;
}

export interface Waypoint {
  latitude: number;
  longitude: number;
  name?: string | null;
  eta?: string | null;
  leg_distance_nm?: number | null;
  /** Per-leg throttle. Route and speed are solved together, not separately. */
  recommended_rpm?: number | null;
  forecast_wind_kn?: number | null;
  forecast_wave_height_m?: number | null;
  forecast_current_kn?: number | null;
  /** Shallowest charted depth on the approach to this waypoint. */
  min_depth_m?: number | null;
}

export interface WearOut {
  /** 1.0 as-new; 1.08 means 8% more fuel for the same work. */
  multiplier: number;
  penalty_lph: number;
  penalty_php_per_hour?: number | null;
}

export interface AdviseRequest {
  vessel?: VesselInput | null;
  sea?: SeaInput | null;
  heading_deg?: number | null;
  distance_remaining_nm?: number | null;
  /** ETA constraint. None means optimise fuel per mile alone. */
  minutes_available?: number | null;
  current_rpm?: number | null;
  passenger_count?: number | null;
  cargo_kg?: number | null;
  /** Measured exhaust gas temperature over this vessel's own healthy baseline at the same load. 1.0 is as-new. None means engine condition unknown. */
  egt_excess_ratio?: number | null;
  php_per_litre?: number | null;
}

export interface AdviseResponse {
  recommendation: SpeedRecommendation;
  power: PowerOut;
  wear: WearOut;
  emissions: EmissionsOut;
  curve: CurvePoint[];
  /** Speed the vessel actually makes at current_rpm in these conditions. Not a function of throttle alone -- weather slows the boat. */
  achievable_speed_kn?: number | null;
  /** Fastest this engine can drive this hull right now. */
  max_speed_kn: number;
  /** False when the schedule cannot be met at any throttle. */
  feasible: boolean;
  notes?: string[] | null;
  /** False when no wear artifact is loaded; engine is then assumed healthy and confidence is reduced accordingly. */
  model_trained: boolean;
}

export interface RouteRequest {
  vessel?: VesselInput | null;
  origin: LatLonInput;
  destination: LatLonInput;
  /** Departure time; the forecast is read forward from it. None means now. */
  depart_at?: string | null;
  /** ETA budget for the whole voyage. None optimises fuel per mile, no schedule. */
  minutes_available?: number | null;
  passenger_count?: number | null;
  cargo_kg?: number | null;
  /** Exhaust temperature over this vessel's healthy baseline. 1.0 is as-new. */
  egt_excess_ratio?: number | null;
}

export interface RouteResponse {
  recommendation: RouteRecommendation;
  /** False when the engine cannot hold the required speed on some leg; the route is still the cheapest lawful track, but arrival will be late. */
  schedule_feasible: boolean;
  /** False when no wear artifact is loaded; the fuel model then assumes a healthy engine. */
  model_trained: boolean;
}

export interface MaintenanceRequest {
  vessel_id?: string | null;
  /** Recent frames, oldest first. A minute or two is plenty. */
  frames: TelemetryFrame[];
  /** This vessel's run-hours, which set cold-start confidence. None uses the baseline's own history count. */
  observed_hours?: number | null;
  /** Engine rated RPM, which turns the frames' RPM and torque into a load fraction and so enables the duty-cycle summary. None omits that section rather than assuming a rating. */
  rated_rpm?: number | null;
}

export interface SafetyRequest {
  vessel_id?: string | null;
  frame: TelemetryFrame;
}

export interface VoyageRecord {
  voyage_id: string;
  vessel_id: string;
  departed_at: string;
  arrived_at: string;
  origin_name?: string | null;
  destination_name?: string | null;
  distance_nm: number;
  /** Actually burned, integrated from the fuel model. */
  fuel_used_l: number;
  /** What the same voyage would have burned without Marine-AI. None when no baseline could be established. */
  baseline_fuel_l?: number | null;
  baseline_method?: BaselineMethod | null;
  passenger_count?: number | null;
  cargo_kg?: number | null;
  /** Provenance. 'simulator' for every record in the hackathon build -- no hardware was used. Never silently defaults to 'sensor'. */
  source?: string | null;
}

export interface EmissionsReport {
  vessel_id: string;
  year: number;
  month: number;
  generated_at: string;
  voyages: number;
  distance_nm: number;
  fuel_used_l: number;
  co2_kg: number;
  /** Against the stated baseline. May be NEGATIVE -- a month that burned more than baseline is a real month and is reported as such, never floored at zero. None when no voyage in the month had a baseline. */
  co2_avoided_kg?: number | null;
  voyages_with_baseline?: number | null;
  baseline_method?: BaselineMethod | null;
  /** Tank-to-wake combustion factor used. A constant of chemistry, not a tuned parameter. */
  emission_factor_kg_per_l: number;
  lines?: EmissionsReportLine[] | null;
  caveats?: string[] | null;
  /** Constant by design. This is an operational record, not a certified emissions inventory, and must not be presented as one. */
  advisory_only?: boolean | null;
}

export interface BridgeState {
  vessel_id: string;
  voyage_id?: string | null;
  generated_at: string;
  connectivity: Connectivity;
  speed: ModuleStatus_SpeedRecommendation_;
  route: ModuleStatus_RouteRecommendation_;
  maintenance: ModuleStatus_MaintenanceStatus_;
  safety: ModuleStatus_SafetyState_;
  voyage_fuel_used_l?: number | null;
  voyage_co2_kg?: number | null;
  /** Against the vessel's own pre-Marine-AI baseline burn. */
  voyage_co2_avoided_kg?: number | null;
  language?: "en" | "fil" | null;
  /** Constant by design. Marine-AI never overrides the captain and never actuates the vessel. Rendered persistently on the display, not buried in a settings page. */
  advisory_only?: true | null;
}

export interface VesselProfile {
  vessel_id: string;
  name: string;
  hull_type: HullType;
  length_overall_m: number;
  draft_m: number;
  displacement_kg: number;
  engine_make_model: string;
  engine_rated_kw: number;
  engine_rated_rpm: number;
  passenger_capacity: number;
}
