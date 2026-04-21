export type SessionMode = 'live' | 'archive'

export type SessionType = 'Race' | 'Qualifying' | 'Sprint' | 'Sprint Qualifying' | 'Practice 1' | 'Practice 2' | 'Practice 3'

export type TyreCompound = 'SOFT' | 'MEDIUM' | 'HARD' | 'INTERMEDIATE' | 'WET'

export interface Driver {
  number: string
  code: string
  name: string
  team: string
  teamColor: string
  position: number
  gap: string
  interval: string
  lastLap: string
  bestLap: string
  tyre: TyreCompound
  tyreAge: number
  pitStops: number
  status: 'ON_TRACK' | 'PIT' | 'OUT'
}

export interface SessionInfo {
  year: number
  gp: string
  circuit: string
  sessionType: SessionType
  isLive: boolean
}

export interface TelemetryPoint {
  time: number
  speed: number
  throttle: number
  brake: number
  gear: number
  rpm: number
  drs: number
}

export interface LapData {
  lapNumber: number
  lapTime: string
  lapTimeMs: number
  sector1: string
  sector2: string
  sector3: string
  compound: TyreCompound
  tyreAge: number
  isPersonalBest: boolean
}

export interface UpcomingSession {
  name: string
  type: SessionType
  dateUTC: string
  circuit: string
  country: string
  round: number
}

// ---------------------------------------------------------------------------
// Live / stream data
// ---------------------------------------------------------------------------

export interface TimingRow {
  position: number
  driverNumber: number
  code: string
  team: string
  teamColour: string
  gap: string
  interval: string
  lastLap: number | null
  bestLap: number | null
  compound: TyreCompound
  tyreAge: number
  status: 'track' | 'pit' | 'out'
}

export interface DriverSectors {
  s1?: number | null
  s2?: number | null
  s3?: number | null
  lap?: number
}

export interface BestSectorEntry {
  time: number
  driver: string
}

export interface SessionBestSectors {
  s1: BestSectorEntry | null
  s2: BestSectorEntry | null
  s3: BestSectorEntry | null
}

export interface WeatherData {
  airTemperature: number
  trackTemperature: number
  humidity: number
  windSpeed: number
  windDirection: number
  rainfall: number
}

export interface TyreDegResult {
  driverCode: string
  compound: TyreCompound
  coefficients: number[]
  rSquared: number
  predictedCurve: { tyreAge: number; predictedLapTime: number }[]
}

export interface ERSResult {
  driverCode: string
  lapNumber: number
  deploymentPercent: number
  harvestPercent: number
}

export interface UndercutResult {
  driverCode: string
  targetDriver: string
  probability: number
  gapDelta: number
  recommendation: string
}

// Track position from FastF1 live (Position.z stream)
export interface DriverPosition {
  x: number
  y: number
  z: number
  status: string
}

// Car telemetry from FastF1 live (CarData.z stream)
// Keyed by driver_number as string (e.g. "33")
export interface CarTelemetry {
  speed: number      // km/h
  rpm: number
  gear: number
  throttle: number   // 0–100
  brake: number      // 0–100
  drs: number        // 0 = off, 12 = open
}

// ---------------------------------------------------------------------------
// Track map (archive replay)
// ---------------------------------------------------------------------------

/** One car's position for a single track-map frame, normalised to 0–1000. */
export interface CarPosition {
  code: string    // three-letter driver code e.g. "VER"
  x: number       // 0–1000 (normalised from FastF1 metres)
  y: number       // 0–1000 (normalised from FastF1 metres)
  status: string  // "OnTrack" | "OffTrack" | etc. from FastF1
}

/** Circuit outline + coordinate bounds sent once per session. */
export interface CircuitOutline {
  points: [number, number][]  // [x, y] pairs normalised 0–1000
  bounds: { min_x: number; max_x: number; min_y: number; max_y: number }
  sectorPoints?: [number, number][]   // [S1→S2 boundary, S2→S3 boundary]
  startTangent?: [number, number]     // unit vector [dx, dy] along track at S/F line
}

// ---------------------------------------------------------------------------
// Schedule / calendar (OpenF1)
// ---------------------------------------------------------------------------

export interface ScheduleSession {
  sessionKey: number
  sessionName: string
  sessionType: string
  dateStart: string
  dateEnd: string
  isLive: boolean
  isPast: boolean
  isUpcoming: boolean
}

export interface ScheduleEvent {
  meetingKey: number
  name: string
  circuit: string
  location: string
  country: string
  countryCode: string
  dateStart: string
  dateEnd: string
  year: number
  sessions: ScheduleSession[]
}

// ---------------------------------------------------------------------------
// Race control & track status (from live stream)
// ---------------------------------------------------------------------------

export interface RaceControlMessage {
  utc: string
  lap: number | null
  category: string
  message: string
  flag: string
}

export interface TrackStatus {
  status: string  // "1" Green | "2" Yellow | "4" SafetyCar | "5" Red | "6" VSC | "7" VSCEnding
  message: string
}

// ---------------------------------------------------------------------------
// Last race & standings (Jolpica/ergast)
// ---------------------------------------------------------------------------

export interface PodiumEntry {
  position: number
  code: string
  full_name: string
  team: string
  time: string | null
  status: string
}

export interface FastestLap {
  code: string
  lap: string | null
  time: string | null
}

export interface LastRaceResult {
  name: string
  round: string | number
  season: string | number
  circuit: string
  date: string
  podium: PodiumEntry[]
  fastest_lap: FastestLap | null
}

export interface DriverStanding {
  position: number
  code: string
  name: string
  team: string
  points: number
  wins: number
}

export interface ConstructorStanding {
  position: number
  name: string
  points: number
  wins: number
}