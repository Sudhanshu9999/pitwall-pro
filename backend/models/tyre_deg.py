"""
Tyre degradation model.

Fits a degree-2 polynomial (quadratic) to lap-time vs tyre-age for each
driver × compound stint. Returns coefficients, R², and a predicted curve
so the frontend can draw the degradation line.

lap_time = a·age² + b·age + c
"""
from __future__ import annotations
from typing import Optional

import numpy as np
from numpy.polynomial import polynomial as P

from schemas.types import LapData, TyreDegResult, TyreCompound


def _filter_valid(laps: list[LapData], compound: Optional[TyreCompound]) -> tuple[np.ndarray, np.ndarray]:
    """Return (tyre_ages, lap_times) arrays for valid laps on a given compound."""
    ages, times = [], []
    for lap in laps:
        if lap.lap_time is None:
            continue
        if compound and lap.compound != compound:
            continue
        if lap.tyre_age <= 0:
            continue
        # Filter out obvious outliers (safety car laps etc.) — anything >110% of median
        ages.append(lap.tyre_age)
        times.append(lap.lap_time)

    if not times:
        return np.array([]), np.array([])

    ages_arr = np.array(ages, dtype=float)
    times_arr = np.array(times, dtype=float)
    median_time = np.median(times_arr)
    mask = times_arr <= median_time * 1.10
    return ages_arr[mask], times_arr[mask]


def fit_tyre_deg(
    driver_code: str,
    laps: list[LapData],
    compound: Optional[TyreCompound] = None,
) -> Optional[TyreDegResult]:
    """
    Fit a quadratic to lap-time vs tyre-age for the given driver / compound.
    Returns None if insufficient data (< 4 laps after filtering).
    """
    if compound is None:
        # Use the most common compound if not specified
        compounds = [l.compound for l in laps if l.lap_time is not None]
        if not compounds:
            return None
        compound = max(set(compounds), key=compounds.count)

    ages, times = _filter_valid(laps, compound)
    if len(ages) < 3:
        return None

    # numpy poly fit: np.polyfit returns [a, b, c] for degree 2
    coeffs = np.polyfit(ages, times, deg=2).tolist()

    # R² calculation
    predicted = np.polyval(coeffs, ages)
    ss_res = float(np.sum((times - predicted) ** 2))
    ss_tot = float(np.sum((times - np.mean(times)) ** 2))
    r_squared = 1.0 - (ss_res / ss_tot) if ss_tot > 0 else 0.0

    # Predicted curve from tyre_age 1 to max_age + 10 for the chart
    max_age = int(ages.max()) + 10
    curve = [
        {"tyre_age": age, "predicted_lap_time": round(float(np.polyval(coeffs, age)), 3)}
        for age in range(1, max_age + 1)
    ]

    return TyreDegResult(
        driver_code=driver_code,
        compound=compound,
        coefficients=[round(c, 6) for c in coeffs],
        r_squared=round(r_squared, 4),
        predicted_curve=curve,
    )


def fit_all_compounds(driver_code: str, laps: list[LapData]) -> list[TyreDegResult]:
    """Fit one model per compound that has enough data."""
    compounds_present = list({l.compound for l in laps if l.lap_time is not None})
    results = []
    for compound in compounds_present:
        result = fit_tyre_deg(driver_code, laps, compound)
        if result is not None:
            results.append(result)
    return results
