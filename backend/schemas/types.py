"""
Pydantic schemas mirroring src/types/index.ts.
Keep field names in sync with the frontend type definitions.
"""
from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

TyreCompound = Literal["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"]
SessionType = Literal[
    "Race", "Qualifying", "Sprint", "Sprint Qualifying",
    "Practice 1", "Practice 2", "Practice 3"
]


# ---------------------------------------------------------------------------
# Archive catalogue
# ---------------------------------------------------------------------------

class EventInfo(BaseModel):
    """One GP entry returned by /api/archive/events"""
    name: str           # "Bahrain Grand Prix"
    round_number: int
    country: str
    circuit: str
    date: str           # ISO date of the main race day "YYYY-MM-DD"


class SessionInfo(BaseModel):
    """One session entry returned by /api/archive/sessions"""
    session_type: SessionType
    date: str           # ISO datetime string


class DriverInfo(BaseModel):
    """One driver entry returned by /api/archive/drivers"""
    driver_number: int
    code: str           # "VER"
    full_name: str
    team: str


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------

class TelemetryPoint(BaseModel):
    """Single telemetry sample — mirrors frontend TelemetryPoint"""
    time: float         # seconds from session start
    speed: float        # km/h
    throttle: float     # 0–100 %
    brake: float        # 0–100 %
    gear: int
    rpm: float
    drs: int            # 0 = off, 1 = eligible, >=8 = open (FastF1 encoding)


class LapTelemetry(BaseModel):
    lap_number: int
    driver_code: str
    points: list[TelemetryPoint]


# ---------------------------------------------------------------------------
# Lap data
# ---------------------------------------------------------------------------

class LapData(BaseModel):
    lap_number: int
    driver_code: str
    lap_time: Optional[float]       # seconds; None for incomplete laps
    sector1: Optional[float]
    sector2: Optional[float]
    sector3: Optional[float]
    compound: TyreCompound
    tyre_age: int                   # laps on current set
    is_personal_best: bool
    pit_in: bool
    pit_out: bool


# ---------------------------------------------------------------------------
# Timing tower row
# ---------------------------------------------------------------------------

class TimingRow(BaseModel):
    """One row in the timing tower — mirrors frontend Driver type"""
    position: int
    driver_number: int
    code: str
    team: str
    team_colour: str = "FFFFFF"   # hex without '#', e.g. "E8002D"
    gap: str            # "+1.234" / "LEADER" / "LAP"
    interval: str       # gap to car ahead
    last_lap: Optional[float]
    best_lap: Optional[float]
    compound: TyreCompound
    tyre_age: int
    status: Literal["track", "pit", "out"]


# ---------------------------------------------------------------------------
# Models output
# ---------------------------------------------------------------------------

class TyreDegResult(BaseModel):
    driver_code: str
    compound: TyreCompound
    coefficients: list[float]   # polynomial coefficients [a, b, c] for ax²+bx+c
    r_squared: float
    predicted_curve: list[dict]  # [{"tyre_age": int, "predicted_lap_time": float}]


class UndercutResult(BaseModel):
    driver_code: str
    target_driver: str
    probability: float          # 0.0 – 1.0
    gap_delta: float            # seconds gained by undercutting
    recommendation: str         # "PIT NOW" / "WAIT" / "OVERCUT"


class ERSResult(BaseModel):
    driver_code: str
    lap_number: int
    deployment_percent: float   # 0–100 % estimated ERS deployment
    harvest_percent: float      # 0–100 % estimated harvest


# ---------------------------------------------------------------------------
# Replay frame (WebSocket message sent per lap)
# ---------------------------------------------------------------------------

class ReplayFrame(BaseModel):
    """One message emitted by the /api/archive/replay WebSocket per lap tick"""
    frame_type: Literal["timing", "telemetry", "lap", "tyre_deg", "undercut", "ers", "end"]
    lap_number: int
    session_key: str            # "{year}_{gp}_{session_type}"
    payload: dict               # typed by frame_type; avoids union complexity over WS
