function getApiUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL
  if (!url) {
    if (typeof window === 'undefined') return ''
    throw new Error('NEXT_PUBLIC_API_URL is not set.')
  }
  return url
}

const BASE = getApiUrl()

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)))
  }
  const res = await fetch(url.toString(), { cache: 'no-store' })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API POST ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface ApiScheduleSession {
  session_key: number
  session_name: string
  session_type: string
  date_start: string
  date_end: string
  is_live: boolean
  is_past: boolean
  is_upcoming: boolean
}

export interface ApiScheduleEvent {
  meeting_key: number
  name: string
  circuit: string
  location: string
  country: string
  country_code: string
  date_start: string
  date_end: string
  year: number
  sessions: ApiScheduleSession[]
}

export interface ApiScheduleResponse {
  year: number
  session_active: boolean
  next_event: ApiScheduleEvent | null
  calendar: ApiScheduleEvent[]
}

export interface ApiPodiumEntry {
  position: number
  code: string
  full_name: string
  team: string
  time: string | null
  status: string
}

export interface ApiLastRaceResponse {
  race: {
    name: string
    round: string | number
    season: string | number
    circuit: string
    date: string
    podium: ApiPodiumEntry[]
    fastest_lap: { code: string; lap: string | null; time: string | null } | null
  } | null
}

export const fetchLastRace = () => get<ApiLastRaceResponse>('/api/schedule/last-race')

export interface ApiDriverStanding {
  position: number
  code: string
  name: string
  team: string
  points: number
  wins: number
}

export interface ApiConstructorStanding {
  position: number
  name: string
  points: number
  wins: number
}

export interface ApiStandingsResponse {
  year: number
  drivers: ApiDriverStanding[]
  constructors: ApiConstructorStanding[]
}

export const fetchStandings = (year?: number) =>
  get<ApiStandingsResponse>('/api/schedule/standings', year ? { year } : undefined)

export const fetchSchedule = (year?: number) =>
  get<ApiScheduleResponse>('/api/schedule', year ? { year } : undefined)

// ---------------------------------------------------------------------------
// Archive catalogue
// ---------------------------------------------------------------------------

export interface ApiEventInfo {
  name: string
  round_number: number
  country: string
  circuit: string
  date: string
}

export interface ApiSessionInfo {
  session_type: string
  date: string
}

export interface ApiDriverInfo {
  driver_number: number
  code: string
  full_name: string
  team: string
}

export const fetchEvents = (year: number) =>
  get<{ year: number; events: ApiEventInfo[] }>('/api/archive/events', { year })

export const fetchSessions = (year: number, gp: string) =>
  get<{ year: number; gp: string; sessions: ApiSessionInfo[] }>('/api/archive/sessions', { year, gp })

export const fetchDrivers = (year: number, gp: string, session: string) =>
  get<{ year: number; gp: string; session: string; drivers: ApiDriverInfo[] }>(
    '/api/archive/drivers',
    { year, gp, session },
  )

// ---------------------------------------------------------------------------
// Session load
// ---------------------------------------------------------------------------

export interface ApiLoadResponse {
  status: 'loaded' | 'already_loaded'
  session_key: string
  max_lap: number
  drivers: string[]
}

export const loadSession = (year: number, gp: string, session: string) =>
  post<ApiLoadResponse>('/api/archive/load', { year, gp, session })

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export const fetchTelemetry = (year: number, gp: string, session: string, driver: string, lap?: number) =>
  get<{ driver: string; lap: number | null; laps: unknown[] }>(
    '/api/archive/telemetry',
    lap !== undefined ? { year, gp, session, driver, lap } : { year, gp, session, driver },
  )

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface ApiLapData {
  lap_number: number
  driver_code: string
  lap_time: number | null
  sector1: number | null
  sector2: number | null
  sector3: number | null
  compound: string
  tyre_age: number
  is_personal_best: boolean
  pit_in: boolean
  pit_out: boolean
}

export interface ApiDriverCompare {
  code: string
  team_name: string
  team_colour: string
  best_lap: number | null
  pit_stops: { lap_number: number; tyre_age: number; compound: string }[]
  laps: ApiLapData[]
}

export interface ApiCompareResponse {
  driverA: ApiDriverCompare
  driverB: ApiDriverCompare
}

export const fetchCompare = (
  year: number,
  gp: string,
  session: string,
  driverA: string,
  driverB: string,
) =>
  get<ApiCompareResponse>('/api/archive/compare', { year, gp, session, driverA, driverB })

// ---------------------------------------------------------------------------
// WebSocket URL helpers
// ---------------------------------------------------------------------------

const WS_BASE = BASE.replace(/^http/, 'ws')

export const archiveReplayUrl = (year: number, gp: string, session: string, driver?: string, driverB?: string) => {
  let url = `${WS_BASE}/api/archive/replay?year=${year}&gp=${encodeURIComponent(gp)}&session=${encodeURIComponent(session)}`
  if (driver)  url += `&driver=${encodeURIComponent(driver)}`
  if (driverB) url += `&driver_b=${encodeURIComponent(driverB)}`
  return url
}

export const liveStreamUrl = () => `${WS_BASE}/api/live/stream`
