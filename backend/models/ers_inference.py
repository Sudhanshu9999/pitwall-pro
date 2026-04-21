"""
ERS deployment inference.

ERS state cannot be read directly from FastF1 telemetry — it's not broadcast.
We infer it from the relationship between throttle position, wheel speed, RPM,
and gear to estimate when the MGU-K is likely deploying vs harvesting.

Heuristics based on F1 ERS physics:
  - Deployment zones: high throttle (>85%), high gear (≥7), moderate-high speed
  - Harvest zones: braking (brake > 20%), trailing throttle (<20%), deceleration
  - MGU-H harvesting: always active under combustion, not directly inferrable

Output: per-lap deployment% and harvest% estimates (0–100).
"""
from __future__ import annotations
from typing import Optional

import numpy as np

from schemas.types import ERSResult, TelemetryPoint


# Maximum ERS energy per lap in Megajoules — regulated at 4 MJ deploy / 2 MJ harvest
_MAX_DEPLOY_MJ = 4.0
_MAX_HARVEST_MJ = 2.0


def _deployment_score(point: TelemetryPoint) -> float:
    """
    Return a 0–1 deployment likelihood for a single telemetry point.
    High when: high throttle, high gear, DRS active, speed > 200 km/h.
    """
    throttle_factor = max(0.0, (point.throttle - 85.0) / 15.0)   # ramps 85→100%
    gear_factor = min(1.0, max(0.0, (point.gear - 6) / 2.0))      # ramps gear 6→8
    speed_factor = min(1.0, max(0.0, (point.speed - 200.0) / 150.0))
    drs_factor = 1.2 if point.drs >= 8 else 1.0
    score = throttle_factor * gear_factor * speed_factor * drs_factor
    return min(1.0, score)


def _harvest_score(point: TelemetryPoint) -> float:
    """
    Return a 0–1 harvest likelihood for a single telemetry point.
    High when braking or coasting (low throttle, moderate speed).
    """
    brake_factor = min(1.0, point.brake / 80.0)
    coast_factor = max(0.0, (20.0 - point.throttle) / 20.0) if point.throttle < 20 else 0.0
    speed_factor = min(1.0, max(0.0, point.speed / 250.0))   # needs some speed to harvest
    return min(1.0, max(brake_factor, coast_factor) * speed_factor)


def infer_ers_for_lap(
    driver_code: str,
    lap_number: int,
    telemetry_points: list[TelemetryPoint],
) -> Optional[ERSResult]:
    """
    Infer ERS deployment and harvest percentages for a single lap.
    Returns None if telemetry is empty.
    """
    if not telemetry_points:
        return None

    deploy_scores = np.array([_deployment_score(p) for p in telemetry_points])
    harvest_scores = np.array([_harvest_score(p) for p in telemetry_points])

    # Weight by time step (assume uniform sampling — good enough for inference)
    mean_deploy = float(np.mean(deploy_scores))
    mean_harvest = float(np.mean(harvest_scores))

    # Scale to 0–100 percent; calibrated against known ERS-heavy circuits
    # (Monza full deploy ≈ 85%, Monaco ≈ 40% due to low-speed corners)
    deploy_pct = round(min(100.0, mean_deploy * 160.0), 1)
    harvest_pct = round(min(100.0, mean_harvest * 140.0), 1)

    return ERSResult(
        driver_code=driver_code,
        lap_number=lap_number,
        deployment_percent=deploy_pct,
        harvest_percent=harvest_pct,
    )


def infer_ers_all_laps(
    driver_code: str,
    lap_telemetry_map: dict[int, list[TelemetryPoint]],
) -> list[ERSResult]:
    """Infer ERS for every lap in the provided dict keyed by lap_number."""
    results = []
    for lap_number, points in sorted(lap_telemetry_map.items()):
        result = infer_ers_for_lap(driver_code, lap_number, points)
        if result:
            results.append(result)
    return results
