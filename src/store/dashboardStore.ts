import { create } from 'zustand'
import {
  SessionMode, SessionType,
  TimingRow, WeatherData, TyreDegResult, ERSResult, UndercutResult,
  DriverPosition, CarTelemetry, RaceControlMessage, TrackStatus,
  CarPosition, CircuitOutline, DriverSectors, SessionBestSectors,
} from '@/types'

export interface SessionParams {
  year: number
  gp: string
  sessionType: SessionType
  driverA?: string
  driverB?: string
}

// Raw shapes as sent by the backend (all snake_case)
interface BackendTimingRow {
  position: number
  driver_number: number
  code: string
  team: string
  team_colour: string
  gap: string
  interval: string
  last_lap: number | null
  best_lap: number | null
  compound: string
  tyre_age: number
  status: 'track' | 'pit' | 'out'
}

interface BackendWeather {
  air_temperature: number | null
  track_temperature: number | null
  humidity: number | null
  wind_speed: number | null
  wind_direction: number | null
  rainfall: number | null
  pressure: number | null
}

interface BackendTyreDegResult {
  driver_code: string
  compound: string
  coefficients: number[]
  r_squared: number
  predicted_curve: { tyre_age: number; predicted_lap_time: number }[]
}

interface BackendERSResult {
  driver_code: string
  lap_number: number
  deployment_percent: number
  harvest_percent: number
}

interface BackendUndercutResult {
  driver_code: string
  target_driver: string
  probability: number
  gap_delta: number
  recommendation: string
}

interface LapFramePayload {
  timing: BackendTimingRow[]
  weather: BackendWeather | null
  tyre_deg: BackendTyreDegResult[]
  ers: BackendERSResult[]
  undercut: BackendUndercutResult[]
  current_lap?: number
  total_laps?: number
  lap_duration?: number
  session_label?: string
  session_type?: string
  race_control?: RaceControlMessage[]
  track_status?: TrackStatus
  positions?: Record<string, DriverPosition>
  car_data?: Record<string, CarTelemetry>
  last_sectors?: Record<string, { s1?: number | null; s2?: number | null; s3?: number | null; lap?: number }>
  best_sectors?: { s1: { time: number; driver: string } | null; s2: { time: number; driver: string } | null; s3: { time: number; driver: string } | null }
}

interface DashboardStore {
  // UI state
  mode: SessionMode
  activeSession: SessionParams | null
  showSelector: boolean

  // WebSocket / replay state
  wsReady: boolean
  wsError: string | null
  replaySpeed: '0.5' | '1' | '2' | '10'
  replayPaused: boolean
  currentLap: number
  totalLaps: number
  sessionLabel: string
  sessionType: string

  // Stream data
  timing: TimingRow[]
  weather: WeatherData | null
  tyreDeg: TyreDegResult[]
  ersResults: ERSResult[]
  undercutResults: UndercutResult[]
  positions: Record<string, DriverPosition>
  carData: Record<string, CarTelemetry>
  raceControl: RaceControlMessage[]
  trackStatus: TrackStatus | null

  // Sector data (archive replay)
  lastSectors: Record<string, DriverSectors>
  bestSectors: SessionBestSectors | null

  // Track map (archive replay)
  circuitOutline: CircuitOutline | null
  carPositions: CarPosition[]
  hasTelemetry: boolean | null   // null = unknown (not yet loaded), false = unavailable
  positionNotice: string | null  // transient notice shown on the track map

  // Registered sendControl fn (set by useReplaySocket on mount)
  sendControl: (action: string, value?: string) => void

  // Setters
  setMode: (mode: SessionMode) => void
  setActiveSession: (session: SessionParams | null) => void
  setShowSelector: (show: boolean) => void
  setWsReady: (ready: boolean) => void
  setWsError: (error: string | null) => void
  setReplaySpeed: (speed: '0.5' | '1' | '2' | '10') => void
  setReplayPaused: (paused: boolean) => void
  applyLapFrame: (payload: LapFramePayload) => void
  updateCarData: (carData: Record<string, CarTelemetry>) => void
  updateTimingGaps: (updates: { code: string; gap: string; interval: string }[]) => void
  setCircuitOutline: (outline: CircuitOutline, hasTelemetry?: boolean) => void
  setCarPositions: (positions: CarPosition[]) => void
  setPositionNotice: (notice: string | null) => void
  addRaceControlMessage: (msg: RaceControlMessage) => void
  setTrackStatus: (status: TrackStatus | null) => void
  registerSendControl: (fn: (action: string, value?: string) => void) => void
  resetStream: () => void
}

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  // UI
  mode: 'live',
  activeSession: null,
  showSelector: false,

  // WS
  wsReady: false,
  wsError: null,
  replaySpeed: '1',
  replayPaused: true,
  currentLap: 0,
  totalLaps: 0,
  sessionLabel: '',
  sessionType: '',

  // Data
  timing: [],
  weather: null,
  tyreDeg: [],
  ersResults: [],
  undercutResults: [],
  positions: {},
  carData: {},
  raceControl: [],
  trackStatus: null,

  // Sectors
  lastSectors: {},
  bestSectors: null,

  // Track map
  circuitOutline: null,
  carPositions: [],
  hasTelemetry: null,
  positionNotice: null,

  // Control bridge — no-op until useReplaySocket registers
  sendControl: () => {},

  setMode: (mode) => set({ mode }),
  setActiveSession: (session) => set({ activeSession: session }),
  setShowSelector: (show) => set({ showSelector: show }),
  setWsReady: (wsReady) => set({ wsReady }),
  setWsError: (wsError) => set({ wsError }),
  setReplaySpeed: (replaySpeed) => set({ replaySpeed }),
  setReplayPaused: (replayPaused) => set({ replayPaused }),

  applyLapFrame: (payload) => {
    // Map snake_case timing rows → camelCase TimingRow
    const timing: TimingRow[] = (payload.timing ?? []).map((row) => ({
      position: row.position,
      driverNumber: row.driver_number,
      code: row.code,
      team: row.team,
      teamColour: row.team_colour,
      gap: row.gap,
      interval: row.interval,
      lastLap: row.last_lap,
      bestLap: row.best_lap,
      compound: row.compound as TimingRow['compound'],
      tyreAge: row.tyre_age,
      status: row.status,
    }))

    // Map snake_case weather → camelCase WeatherData
    const w = payload.weather
    const weather: WeatherData | null = w
      ? {
          airTemperature: w.air_temperature ?? 0,
          trackTemperature: w.track_temperature ?? 0,
          humidity: w.humidity ?? 0,
          windSpeed: w.wind_speed ?? 0,
          windDirection: w.wind_direction ?? 0,
          rainfall: w.rainfall ?? 0,
        }
      : null

    const tyreDeg: TyreDegResult[] = (payload.tyre_deg ?? []).map((r) => ({
      driverCode: r.driver_code,
      compound: r.compound as TyreDegResult['compound'],
      coefficients: r.coefficients,
      rSquared: r.r_squared,
      predictedCurve: r.predicted_curve.map((p) => ({
        tyreAge: p.tyre_age,
        predictedLapTime: p.predicted_lap_time,
      })),
    }))

    const ersResults: ERSResult[] = (payload.ers ?? []).map((r) => ({
      driverCode: r.driver_code,
      lapNumber: r.lap_number,
      deploymentPercent: r.deployment_percent,
      harvestPercent: r.harvest_percent,
    }))

    const undercutResults: UndercutResult[] = (payload.undercut ?? []).map((r) => ({
      driverCode: r.driver_code,
      targetDriver: r.target_driver,
      probability: r.probability,
      gapDelta: r.gap_delta,
      recommendation: r.recommendation,
    }))

    // Preserve existing timing if the incoming frame has none (e.g. lap 1 with
    // missing LapTime data falls back to Position ordering — may still return []
    // in edge cases; keeping the grid state is better than showing "Awaiting").
    const finalTiming = timing.length > 0 ? timing : get().timing

    set({
      timing: finalTiming,
      weather,
      tyreDeg,
      ersResults,
      undercutResults,
      currentLap: payload.current_lap ?? 0,
      totalLaps: payload.total_laps ?? 0,
      sessionLabel: payload.session_label ?? '',
      sessionType: payload.session_type ?? get().sessionType,
      // Historical messages arrive oldest-first; reverse so index 0 = newest,
      // consistent with addRaceControlMessage prepending live messages.
      raceControl: [...(payload.race_control ?? [])].reverse(),
      trackStatus: payload.track_status ?? null,
      positions: payload.positions ?? {},
      carData: payload.car_data ?? {},
      lastSectors: payload.last_sectors ?? {},
      bestSectors: payload.best_sectors ?? null,
    })
  },

  updateCarData: (update) => set((state) => ({ carData: { ...state.carData, ...update } })),

  updateTimingGaps: (updates) => set((state) => {
    const map: Record<string, { gap: string; interval: string }> = {}
    for (const u of updates) map[u.code] = { gap: u.gap, interval: u.interval }
    return {
      timing: state.timing.map((row) =>
        map[row.code] ? { ...row, ...map[row.code] } : row
      ),
    }
  }),

  setCircuitOutline: (outline, hasTelemetry) => set({
    circuitOutline: outline,
    ...(hasTelemetry !== undefined ? { hasTelemetry } : {}),
  }),
  setCarPositions: (positions) => set({ carPositions: positions }),
  setPositionNotice: (notice) => set({ positionNotice: notice }),

  // Prepend a single new message to the top of the race control feed
  addRaceControlMessage: (msg) => set((state) => ({
    raceControl: [msg, ...state.raceControl],
  })),
  setTrackStatus: (status) => set({ trackStatus: status }),

  registerSendControl: (fn) => set({ sendControl: fn }),

  resetStream: () =>
    set({
      wsReady: false,
      wsError: null,
      timing: [],
      weather: null,
      tyreDeg: [],
      ersResults: [],
      undercutResults: [],
      currentLap: 0,
      totalLaps: 0,
      sessionLabel: '',
      sessionType: '',
      replayPaused: true,
      positions: {},
      carData: {},
      raceControl: [],
      trackStatus: null,
      circuitOutline: null,
      carPositions: [],
      hasTelemetry: null,
      positionNotice: null,
      lastSectors: {},
      bestSectors: null,
    }),
}))
