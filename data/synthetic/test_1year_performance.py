"""Full performance and diagnostic test for Predictive Maintenance on 1-year dataset.

Evaluates:
1. Ingest/Parsing speed (109k+ rows)
2. Condition Model refitting speed & model coverage
3. Telemetry scoring throughput (frames/sec)
4. Anomaly detection accuracy & false alarm rate on healthy period vs detection rate on failure phase
5. Exposure & Component Life accuracy
"""

from __future__ import annotations

import time
import os
import numpy as np

from services.maintenance.history import parse_history_csv, refit_from_history
from services.maintenance.baseline import VesselBaseline, fit_from_frames
from services.maintenance.detector import detect
from services.maintenance.lifespan import resolve_component_life
from services.maintenance.duty import duty_cycle

def main():
    csv_path = "data/synthetic/engine_telemetry_1year.csv"
    
    print("=================================================================")
    print(" PREDICTIVE MAINTENANCE SYSTEM: 1-YEAR SCALE PERFORMANCE BENCHMARK")
    print("=================================================================")
    print(f"Dataset File: {csv_path} ({os.path.getsize(csv_path) / 1024 / 1024:.2f} MB)")
    
    # 1. PARSING BENCHMARK
    t0 = time.perf_counter()
    with open(csv_path, "r", encoding="utf-8") as f:
        csv_text = f.read()
    read_time = time.perf_counter() - t0
    
    t0 = time.perf_counter()
    frames, summary = parse_history_csv(csv_text, vessel_id="MV-DEMO-YEAR1")
    parse_time = time.perf_counter() - t0
    
    print("\n1. DATASET INGEST & PARSING")
    print(f"  File Read Time   : {read_time*1000:.2f} ms")
    print(f"  Parse Time       : {parse_time*1000:.2f} ms ({len(frames) / parse_time:.0f} frames/sec)")
    print(f"  Rows Received    : {summary.rows_received}")
    print(f"  Rows Accepted    : {summary.rows_accepted} ({summary.rows_accepted/summary.rows_received*100:.1f}%)")
    print(f"  Channels Mapped  : {len(summary.channels_mapped)} {summary.channels_mapped}")
    print(f"  Time Span        : {summary.span_hours:.1f} hours ({summary.span_hours/24:.1f} operational days)")

    # 2. CONDITION MODEL FIT BENCHMARK
    # Fit baseline on healthy period (first 50,000 frames (~Months 1-6))
    healthy_frames = frames[:50000]
    t0 = time.perf_counter()
    rated_rpm = 2800.0
    models, refit_summary = refit_from_history(healthy_frames, rated_rpm=rated_rpm, summary=summary)
    fit_time = time.perf_counter() - t0

    baseline = fit_from_frames(healthy_frames, observed_hours=800.0)

    print("\n2. CONDITION MODEL & BASELINE FITTING")
    print(f"  Model Fit Time   : {fit_time*1000:.2f} ms")
    print(f"  Models Refitted  : {len(refit_summary.models_refitted)} channels")
    print(f"  Baseline Confidence: {baseline.baseline_confidence * 100:.1f}%")
    print("  Weather/Operating Condition Coverage:")
    for k, v in refit_summary.conditions_covered.items():
        print(f"    - {k:<20}: {v}")

    # 3. ANOMALY DETECTOR SCORING BENCHMARK
    t0 = time.perf_counter()
    window_size = 20
    windows_scored = 0
    anomalous_windows = 0
    scores = []
    
    # Track quarterly timeline performance
    quarterly_scores = {1: [], 2: [], 3: [], 4: []}
    quarter_len = len(frames) // 4

    for i in range(0, len(frames) - window_size, window_size):
        win = frames[i : i + window_size]
        quarter = min(4, (i // quarter_len) + 1)
        
        status = detect(
            win,
            baseline,
            vessel_id="MV-DEMO-YEAR1",
            observed_hours=800.0,
            rated_rpm=rated_rpm,
        )
        windows_scored += 1
        scores.append(status.anomaly_score)
        quarterly_scores[quarter].append(status.anomaly_score)
        if status.is_anomalous:
            anomalous_windows += 1

    score_time = time.perf_counter() - t0
    
    print("\n3. SCORING BENCHMARK & ANOMALY DETECTION METRICS")
    print(f"  Total Scoring Time: {score_time*1000:.2f} ms")
    print(f"  Scoring Speed     : {(windows_scored * window_size) / score_time:.0f} frames/sec ({windows_scored / score_time:.0f} windows/sec)")
    print(f"  Total Windows     : {windows_scored}")
    print(f"  Anomalous Windows : {anomalous_windows} ({anomalous_windows / windows_scored * 100:.1f}%)")

    print("\n  Quarterly Anomaly Score Progression (Timeline Accuracy):")
    q_names = ["Q1 (Months 1-3: Healthy/Break-in)", "Q2 (Months 4-6: Stable Normal)", "Q3 (Months 7-9: Thermal Drift Onset)", "Q4 (Months 10-12: Severe Wear/Near-Failure)"]
    for q in range(1, 5):
        q_sc = quarterly_scores[q]
        avg_q = np.mean(q_sc) if q_sc else 0.0
        max_q = np.max(q_sc) if q_sc else 0.0
        pct_anom = (np.sum(np.array(q_sc) >= 0.6) / len(q_sc) * 100) if q_sc else 0.0
        status_flag = "[NOMINAL]" if avg_q < 0.35 else ("[DEVIATING]" if avg_q < 0.7 else "[CRITICAL ANOMALY]")
        print(f"    {q_names[q-1]:<45} Avg: {avg_q:.4f} | Max: {max_q:.4f} | % Anomalous: {pct_anom:5.1f}% {status_flag}")

    # 4. DUTY CYCLE & LIFESPAN CALCULATION BENCHMARK
    t0 = time.perf_counter()
    duty = duty_cycle(frames, rated_rpm=rated_rpm)
    duty_time = time.perf_counter() - t0

    t0 = time.perf_counter()
    report = resolve_component_life(
        vessel_id="MV-DEMO-YEAR1",
        wear_hours=duty.weighted_hours,
        severity_index=duty.severity_index,
        hours_per_day=5.0,
    )
    life_time = time.perf_counter() - t0

    print("\n4. DUTY CYCLE & COMPONENT LIFESPAN BENCHMARK")
    print(f"  Duty Calculation Time  : {duty_time*1000:.2f} ms")
    print(f"  Life Resolution Time   : {life_time*1000:.2f} ms")
    print(f"  Total Run-Hours        : {duty.total_hours:.1f} hrs")
    print(f"  Total Wear-Hours       : {duty.weighted_hours:.1f} wear-hrs")
    print(f"  Engine Severity Index  : {duty.severity_index:.2f}x cruise")
    print(f"  Dominant Operating Band: {duty.dominant_band.upper()}")

    print("\n5. SYSTEM VERDICT SUMMARY")
    print(f"  Advisory: {report.advisory_en}")
    print("  Component Health Status:")
    for c in report.components:
        bar = "#" * int(c.life_score * 10) + "-" * (10 - int(c.life_score * 10))
        print(f"    - {c.label_en:<32} [{bar}] {c.life_score*100:5.1f}% left ({c.wear_hours_remaining:.0f} wear-hrs / ~{c.months_remaining or 0:.0f} mo)")

    total_pipeline_time = parse_time + fit_time + score_time + duty_time + life_time
    print(f"\nTOTAL PIPELINE LATENCY FOR 1-YEAR DATASET (109,238 FRAMES): {total_pipeline_time:.3f} SECONDS")
    print("=================================================================")

if __name__ == "__main__":
    main()
