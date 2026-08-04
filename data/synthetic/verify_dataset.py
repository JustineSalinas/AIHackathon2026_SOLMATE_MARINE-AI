"""Verify the 1-year synthetic telemetry dataset against the system's maintenance services.

Tests:
1. history.py parsing of monthly CSVs
2. baseline fitting on healthy period (months 1-6)
3. anomaly scoring progression across months 1 to 12
4. lifespan and component wear hours calculation
"""

from __future__ import annotations

import os
import glob
from services.maintenance.history import parse_history_csv, refit_from_history
from services.maintenance.baseline import VesselBaseline, fit_from_frames
from services.maintenance.detector import detect
from services.maintenance.lifespan import resolve_component_life
from services.maintenance.duty import duty_cycle

def main() -> None:
    monthly_dir = "data/synthetic/engine_telemetry_monthly"
    month_files = sorted(glob.glob(os.path.join(monthly_dir, "month_*.csv")))
    
    print(f"Found {len(month_files)} monthly files.")

    all_frames = []
    monthly_frames = {}

    for idx, path in enumerate(month_files, 1):
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        frames, summary = parse_history_csv(text, vessel_id="MV-DEMO-01")
        monthly_frames[idx] = frames
        all_frames.extend(frames)
        print(f"Month {idx:02d}: {summary.rows_accepted} rows parsed, {len(summary.channels_mapped)} channels mapped.")

    print(f"\nTotal frames parsed across 1 year: {len(all_frames)}")

    # 1. Fit baseline on healthy months (Months 2 to 6, after break-in)
    healthy_frames = []
    for m in range(2, 7):
        healthy_frames.extend(monthly_frames[m])

    rated_rpm = 2800.0
    baseline = fit_from_frames(healthy_frames, observed_hours=800.0)
    print("\n--- Baseline Fitted (Months 2-6) ---")
    print(f"Baseline Confidence: {baseline.baseline_confidence}")
    print(f"Feature centers: {baseline.center.round(2)}")
    print(f"Feature scales:  {baseline.scale.round(2)}")

    # 2. Score monthly samples against the fitted baseline
    print("\n--- Monthly Anomaly Score Progression ---")
    print(f"{'Month':<8} {'Avg Score':<12} {'Max Score':<12} {'% Anomalous':<12} {'Primary Deviation Channel'}")
    print("-" * 75)

    for m in range(1, 13):
        frames = monthly_frames[m]
        window_size = 20
        scores = []
        top_streams = []

        for i in range(0, len(frames) - window_size, window_size):
            win = frames[i : i + window_size]
            status = detect(
                win,
                baseline,
                vessel_id="MV-DEMO-01",
                observed_hours=m * 150.0,
                rated_rpm=rated_rpm,
            )
            scores.append(status.anomaly_score)
            if status.is_anomalous and status.streams:
                top_streams.append(status.streams[0].label_en)

        avg_score = sum(scores) / len(scores) if scores else 0.0
        max_score = max(scores) if scores else 0.0
        pct_anom = (sum(1 for s in scores if s >= 0.6) / len(scores) * 100) if scores else 0.0
        
        main_stream = max(set(top_streams), key=top_streams.count) if top_streams else "None"
        print(f"Month {m:02d}    {avg_score:<12.4f} {max_score:<12.4f} {pct_anom:<12.1f}% {main_stream}")

    # 3. Duty cycle and Component Life at end of Year 1
    total_duty = duty_cycle(all_frames, rated_rpm=rated_rpm)
    print("\n--- 1-Year Duty Cycle & Exposure ---")
    print(f"Total Running Hours : {total_duty.total_hours:.1f} hrs")
    print(f"Total Weighted Hours: {total_duty.weighted_hours:.1f} wear-hrs")
    print(f"Severity Index      : {total_duty.severity_index:.2f}")
    print(f"Dominant Band       : {total_duty.dominant_band}")

    report = resolve_component_life(
        vessel_id="MV-DEMO-01",
        wear_hours=total_duty.weighted_hours,
        severity_index=total_duty.severity_index,
        hours_per_day=5.0,
    )

    print("\n--- 1-Year Component Life Report ---")
    print(f"Advisory: {report.advisory_en}")
    print(f"{'Component':<32} {'Consumed (hrs)':<16} {'Remaining (hrs)':<16} {'Condition'}")
    print("-" * 75)
    for c in report.components:
        print(f"{c.label_en:<32} {c.wear_hours_consumed:<16.1f} {c.wear_hours_remaining:<16.1f} {c.condition.value}")

if __name__ == "__main__":
    main()
