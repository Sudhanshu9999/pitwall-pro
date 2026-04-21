"""
Undercut probability calculator.

The undercut works when:
  1. The attacking driver pits first and gains track position after the target pits.
  2. The new tyre lap time advantage exceeds the pit stop time loss plus the gap.

Model inputs:
  - current_gap:      gap in seconds from attacker to target (positive = attacker behind)
  - pit_loss:         estimated time lost stationary in pit lane (default 22s for most circuits)
  - laps_remaining:   number of laps left in the stint / race
  - attacker_deg:     tyre degradation coefficient for attacker (from TyreDeg model, coeff[1])
  - target_deg:       tyre degradation coefficient for target

Probability is computed from a sigmoid over the expected net delta. A delta > 0
means the undercut gains time, and probability increases accordingly.
"""
from __future__ import annotations
import math
from typing import Optional

from schemas.types import LapData, TyreDegResult, UndercutResult


def _lap_time_at_age(coeffs: list[float], age: int) -> float:
    """Evaluate polynomial at tyre_age."""
    a, b, c = coeffs
    return a * age**2 + b * age + c


def _estimate_pit_loss(circuit_name: str = "") -> float:
    """
    Approximate pit lane time loss by circuit. Falls back to 22s average.
    These values are well-established constants from broadcast timing.
    """
    PIT_LOSS: dict[str, float] = {
        "Monaco": 28.0,
        "Singapore": 26.0,
        "Baku": 24.0,
        "Jeddah": 24.0,
        "Australia": 23.0,
        "Bahrain": 22.5,
        "Japan": 22.5,
        "Spain": 21.5,
        "Silverstone": 21.0,
        "Hungary": 21.0,
        "Monza": 20.0,
        "Spa": 20.0,
    }
    for name, loss in PIT_LOSS.items():
        if name.lower() in circuit_name.lower():
            return loss
    return 22.0


def calculate_undercut_probability(
    attacker_code: str,
    target_code: str,
    current_gap: float,
    attacker_tyre_age: int,
    target_tyre_age: int,
    attacker_deg: Optional[TyreDegResult],
    target_deg: Optional[TyreDegResult],
    laps_remaining: int = 10,
    circuit_name: str = "",
) -> UndercutResult:
    """
    Compute the probability that attacker can undercut target.

    Returns UndercutResult with probability [0,1] and recommendation.
    """
    pit_loss = _estimate_pit_loss(circuit_name)

    # If we have deg models, compute time gain per lap on fresh tyres
    # vs target continuing on old tyres over `laps_remaining` laps
    if attacker_deg and target_deg and len(attacker_deg.coefficients) == 3 and len(target_deg.coefficients) == 3:
        # Attacker on fresh tyres (age 1..laps_remaining)
        attacker_fresh_time = sum(
            _lap_time_at_age(attacker_deg.coefficients, age)
            for age in range(1, laps_remaining + 1)
        )
        # Target continuing on worn tyres
        target_worn_time = sum(
            _lap_time_at_age(target_deg.coefficients, target_tyre_age + age)
            for age in range(1, laps_remaining + 1)
        )
        time_gained = target_worn_time - attacker_fresh_time
    else:
        # Fallback: simple heuristic — each extra lap on old tyres costs ~0.1s
        age_delta = target_tyre_age - attacker_tyre_age
        time_gained = age_delta * 0.08 * laps_remaining

    # Net delta: positive means undercut gains time after absorbing pit loss
    net_delta = time_gained - pit_loss - current_gap

    # Sigmoid probability centred at net_delta=0, k controls steepness
    k = 0.5
    probability = 1.0 / (1.0 + math.exp(max(-500.0, min(500.0, -k * net_delta))))

    if probability >= 0.65:
        recommendation = "PIT NOW"
    elif probability >= 0.45:
        recommendation = "MONITOR"
    else:
        recommendation = "WAIT"

    return UndercutResult(
        driver_code=attacker_code,
        target_driver=target_code,
        probability=round(probability, 3),
        gap_delta=round(net_delta, 2),
        recommendation=recommendation,
    )
