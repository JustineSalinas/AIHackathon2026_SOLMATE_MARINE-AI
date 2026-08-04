"""Generate a realistic 1-year engine telemetry dataset for predictive maintenance simulation.

Dataset timeline (365 days):
- Days 1-30: Break-in period (slightly elevated oil particulates, bedding in)
- Days 31-200: Healthy cruise (varied weather, load profiles, baseline operation)
- Days 201-300: Gradual degradation (coolant fouling, EGT creeping, oil particulate rising)
- Days 301-340: Accelerated wear (vibration rising due to bearing/shaft wear, oil pressure sagging)
- Days 341-365: Near-failure state (multiple channels deviating, high anomaly scores)

Oil changes occur on day 120 and 240 (particulates reset).

Outputs:
- data/synthetic/engine_telemetry_1year.csv (complete 1-year dataset)
- data/synthetic/engine_telemetry_monthly/ (12 monthly CSV files for step-by-step demo import)
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timedelta, timezone
import numpy as np

# Healthy reference values (matching baseline.py & telemetry.ts)
HEALTHY_MEAN = {
    "coolant_temp_c": 82.0,
    "oil_pressure_kpa": 350.0,
    "battery_voltage_v": 13.8,
    "exhaust_gas_temp_c": 380.0,
    "oil_particulate_ppm": 15.0,
    "exhaust_nox_ppm": 600.0,
    "vibration_rms_g": 0.05,
}

HEALTHY_SIGMA = {
    "coolant_temp_c": 3.0,
    "oil_pressure_kpa": 20.0,
    "battery_voltage_v": 0.3,
    "exhaust_gas_temp_c": 25.0,
    "oil_particulate_ppm": 5.0,
    "exhaust_nox_ppm": 80.0,
    "vibration_rms_g": 0.015,
}

LOAD_GAIN = {
    "coolant_temp_c": 0.6,
    "oil_pressure_kpa": -0.2,
    "battery_voltage_v": 0.0,
    "exhaust_gas_temp_c": 0.7,
    "oil_particulate_ppm": 0.1,
    "exhaust_nox_ppm": 0.3,
    "vibration_rms_g": 0.2,
}

def generate_year_dataset(
    output_dir: str = "data/synthetic",
    seed: int = 2026,
    sample_interval_minutes: int = 1,
) -> None:
    rng = np.random.default_rng(seed)
    start_date = datetime(2025, 1, 1, 6, 0, 0, tzinfo=timezone.utc)

    os.makedirs(output_dir, exist_ok=True)
    monthly_dir = os.path.join(output_dir, "engine_telemetry_monthly")
    os.makedirs(monthly_dir, exist_ok=True)

    header = (
        "timestamp,engine_rpm,coolant_temp_c,oil_pressure_kpa,battery_voltage_v,"
        "exhaust_gas_temp_c,oil_particulate_ppm,exhaust_nox_ppm,vibration_rms_g,"
        "wave_height_m,heading_deg,wind_direction_deg,wind_speed_kn\n"
    )

    full_csv_path = os.path.join(output_dir, "engine_telemetry_1year.csv")
    
    monthly_files = {}
    for m in range(1, 13):
        monthly_files[m] = open(
            os.path.join(monthly_dir, f"month_{m:02d}.csv"), "w", encoding="utf-8"
        )
        monthly_files[m].write(header)

    full_file = open(full_csv_path, "w", encoding="utf-8")
    full_file.write(header)

    rows_count = 0
    engine_hours = 0.0

    print("Generating 1-year engine telemetry dataset...")

    for day in range(1, 366):
        current_day_date = start_date + timedelta(days=day - 1)
        month = current_day_date.month

        # Determine daily operating schedule (e.g. 2 trips: 06:00-08:30 and 14:00-16:30)
        # Randomize trip lengths slightly
        trip1_duration_hrs = rng.uniform(2.0, 3.0)
        trip2_duration_hrs = rng.uniform(2.0, 3.0)

        trips = [
            (current_day_date.replace(hour=6, minute=0), trip1_duration_hrs),
            (current_day_date.replace(hour=14, minute=0), trip2_duration_hrs),
        ]

        # Degradation state factors
        # 1. Break-in (1-30)
        break_in_particulate_extra = max(0.0, (30 - day) / 30.0 * 12.0) if day <= 30 else 0.0
        
        # 2. Gradual degradation (201-300)
        deg_coolant = max(0.0, (day - 200) * 0.15) if day > 200 else 0.0
        deg_egt = max(0.0, (day - 200) * 0.4) if day > 200 else 0.0

        # Oil particulate accumulation & resets on day 120 and 240
        days_since_oil_change = day if day < 120 else ((day - 120) if day < 240 else (day - 240))
        oil_particulate_wear = (days_since_oil_change / 120.0) * 15.0

        # 3. Accelerated wear (301-340)
        deg_vibration = max(0.0, (day - 300) * 0.003) if day > 300 else 0.0
        deg_oil_pressure_drop = max(0.0, (day - 300) * 1.8) if day > 300 else 0.0

        # 4. Near-failure (341-365)
        if day > 340:
            deg_coolant += (day - 340) * 0.4
            deg_vibration += (day - 340) * 0.005
            deg_oil_pressure_drop += (day - 340) * 2.5

        # Ambient / Weather for the day
        base_wave = max(0.2, rng.normal(0.8, 0.3))
        base_wind_speed = max(3.0, base_wave * 12.0 + rng.normal(0, 2))
        wind_dir = (rng.uniform(0, 360)) % 360
        heading = (wind_dir + rng.choice([45, 90, 135, 180, 225, 270])) % 360

        for trip_start, duration_hrs in trips:
            steps = int((duration_hrs * 60) / sample_interval_minutes)
            
            for step in range(steps):
                ts = trip_start + timedelta(minutes=step * sample_interval_minutes)
                engine_hours += sample_interval_minutes / 60.0

                # Throttle profile: warmup (5%), cruise (80%), maneuvering/heavy (15%)
                progress = step / steps
                if progress < 0.08 or progress > 0.92:
                    throttle_pct = rng.normal(35.0, 3.0)  # harbor / idle-light
                elif 0.4 < progress < 0.6 and rng.random() < 0.3:
                    throttle_pct = rng.normal(88.0, 2.0)  # heavy load surge
                else:
                    throttle_pct = rng.normal(72.0, 4.0)  # steady cruise

                throttle_pct = max(10.0, min(100.0, throttle_pct))
                rpm = (throttle_pct / 100.0) * 2800.0 + rng.normal(0, 15)

                # Standardized load about cruise (70%)
                load = (throttle_pct - 70.0) / 20.0

                # Weather noise per frame
                wave_m = max(0.1, base_wave + rng.normal(0, 0.05))
                wind_kn = max(0.0, base_wind_speed + rng.normal(0, 1.0))

                # Sensor channels with load gain + noise + physical anomalies
                # 1. Coolant temp
                coolant = (
                    HEALTHY_MEAN["coolant_temp_c"]
                    + load * LOAD_GAIN["coolant_temp_c"] * HEALTHY_SIGMA["coolant_temp_c"]
                    + rng.normal(0, HEALTHY_SIGMA["coolant_temp_c"] * 0.5)
                    + deg_coolant
                )

                # 2. Oil pressure (drops under wear / temp rise)
                oil_press = (
                    HEALTHY_MEAN["oil_pressure_kpa"]
                    + load * LOAD_GAIN["oil_pressure_kpa"] * HEALTHY_SIGMA["oil_pressure_kpa"]
                    + rng.normal(0, HEALTHY_SIGMA["oil_pressure_kpa"] * 0.4)
                    - deg_oil_pressure_drop
                )
                oil_press = max(50.0, oil_press)

                # 3. Battery voltage
                battery = (
                    HEALTHY_MEAN["battery_voltage_v"]
                    + rng.normal(0, HEALTHY_SIGMA["battery_voltage_v"] * 0.5)
                )

                # 4. Exhaust gas temp
                egt = (
                    HEALTHY_MEAN["exhaust_gas_temp_c"]
                    + load * LOAD_GAIN["exhaust_gas_temp_c"] * HEALTHY_SIGMA["exhaust_gas_temp_c"]
                    + rng.normal(0, HEALTHY_SIGMA["exhaust_gas_temp_c"] * 0.5)
                    + deg_egt
                )

                # 5. Oil particulate ppm
                particulate = (
                    HEALTHY_MEAN["oil_particulate_ppm"]
                    + break_in_particulate_extra
                    + oil_particulate_wear
                    + rng.normal(0, 1.5)
                )
                particulate = max(1.0, particulate)

                # 6. Exhaust NOx
                nox = (
                    HEALTHY_MEAN["exhaust_nox_ppm"]
                    + load * LOAD_GAIN["exhaust_nox_ppm"] * HEALTHY_SIGMA["exhaust_nox_ppm"]
                    + rng.normal(0, HEALTHY_SIGMA["exhaust_nox_ppm"] * 0.4)
                )
                nox = max(50.0, nox)

                # 7. Vibration RMS (increases with wave height & mechanical degradation)
                vibration = (
                    HEALTHY_MEAN["vibration_rms_g"]
                    + load * LOAD_GAIN["vibration_rms_g"] * HEALTHY_SIGMA["vibration_rms_g"]
                    + (wave_m * 0.01)  # sea state effect
                    + deg_vibration
                    + max(0.0, rng.normal(0, 0.005))
                )

                row_str = (
                    f"{ts.isoformat()},{rpm:.1f},{coolant:.2f},{oil_press:.1f},"
                    f"{battery:.2f},{egt:.1f},{particulate:.1f},{nox:.1f},"
                    f"{vibration:.4f},{wave_m:.2f},{heading:.1f},{wind_dir:.1f},{wind_kn:.1f}\n"
                )

                full_file.write(row_str)
                monthly_files[month].write(row_str)
                rows_count += 1

    full_file.close()
    for f in monthly_files.values():
        f.close()

    print(f"Done! Generated {rows_count} rows (~{engine_hours:.1f} engine operating hours).")
    print(f"Main dataset: {full_csv_path}")
    print(f"Monthly splits: {monthly_dir}/month_01.csv .. month_12.csv")


if __name__ == "__main__":
    generate_year_dataset()
