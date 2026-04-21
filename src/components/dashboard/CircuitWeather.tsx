'use client'

import { useEffect, useState } from 'react'
import { ApiScheduleEvent, ApiScheduleSession } from '@/lib/api'

// WMO weather interpretation codes → label + emoji
function wmoLabel(code: number): { label: string; icon: string } {
  if (code === 0)            return { label: 'Clear',         icon: '☀️' }
  if (code === 1)            return { label: 'Mainly clear',  icon: '🌤️' }
  if (code === 2)            return { label: 'Partly cloudy', icon: '⛅' }
  if (code === 3)            return { label: 'Overcast',      icon: '☁️' }
  if (code <= 48)            return { label: 'Foggy',         icon: '🌫️' }
  if (code <= 55)            return { label: 'Drizzle',       icon: '🌦️' }
  if (code <= 65)            return { label: 'Rain',          icon: '🌧️' }
  if (code <= 77)            return { label: 'Snow',          icon: '❄️' }
  if (code <= 82)            return { label: 'Rain showers',  icon: '🌧️' }
  if (code <= 94)            return { label: 'Thunderstorm',  icon: '⛈️' }
  return                            { label: 'Thunderstorm',  icon: '⛈️' }
}

// F1 circuit coordinate lookup — matched against nextEvent.location / .name
const CIRCUIT_COORDS: Array<{ keys: string[]; lat: number; lon: number; tz: string }> = [
  { keys: ['bahrain', 'sakhir'],               lat: 26.0325,  lon: 50.5106,   tz: 'Asia/Bahrain' },
  { keys: ['jeddah', 'saudi'],                 lat: 21.6319,  lon: 39.1044,   tz: 'Asia/Riyadh' },
  { keys: ['melbourne', 'australia', 'albert'], lat: -37.8497, lon: 144.968,  tz: 'Australia/Melbourne' },
  { keys: ['suzuka', 'japan'],                 lat: 34.8431,  lon: 136.5407,  tz: 'Asia/Tokyo' },
  { keys: ['shanghai', 'china'],               lat: 31.3389,  lon: 121.2198,  tz: 'Asia/Shanghai' },
  { keys: ['miami'],                           lat: 25.9581,  lon: -80.2389,  tz: 'America/New_York' },
  { keys: ['imola', 'emilia'],                 lat: 44.3439,  lon: 11.7167,   tz: 'Europe/Rome' },
  { keys: ['monaco', 'monte'],                 lat: 43.7347,  lon: 7.4205,    tz: 'Europe/Monaco' },
  { keys: ['montreal', 'canada', 'gilles'],    lat: 45.5017,  lon: -73.5227,  tz: 'America/Toronto' },
  { keys: ['barcelona', 'spain', 'catalunya'], lat: 41.57,    lon: 2.2611,    tz: 'Europe/Madrid' },
  { keys: ['silverstone', 'britain', 'british'], lat: 52.0786, lon: -1.0169,  tz: 'Europe/London' },
  { keys: ['budapest', 'hungary', 'hungaroring'], lat: 47.5789, lon: 19.2486, tz: 'Europe/Budapest' },
  { keys: ['spa', 'belgium'],                  lat: 50.4372,  lon: 5.9714,    tz: 'Europe/Brussels' },
  { keys: ['zandvoort', 'netherlands', 'dutch'], lat: 52.3888, lon: 4.5408,   tz: 'Europe/Amsterdam' },
  { keys: ['monza', 'italy', 'italian'],       lat: 45.6156,  lon: 9.2811,    tz: 'Europe/Rome' },
  { keys: ['baku', 'azerbaijan'],              lat: 40.3725,  lon: 49.8533,   tz: 'Asia/Baku' },
  { keys: ['singapore', 'marina bay'],         lat: 1.2914,   lon: 103.864,   tz: 'Asia/Singapore' },
  { keys: ['austin', 'cota', 'united states'], lat: 30.1328,  lon: -97.6411,  tz: 'America/Chicago' },
  { keys: ['mexico', 'hermanos'],              lat: 19.4042,  lon: -99.0907,  tz: 'America/Mexico_City' },
  { keys: ['são paulo', 'sao paulo', 'brazil', 'interlagos'], lat: -23.7036, lon: -46.6997, tz: 'America/Sao_Paulo' },
  { keys: ['las vegas'],                       lat: 36.1147,  lon: -115.1728, tz: 'America/Los_Angeles' },
  { keys: ['lusail', 'qatar'],                 lat: 25.49,    lon: 51.454,    tz: 'Asia/Qatar' },
  { keys: ['abu dhabi', 'yas marina'],         lat: 24.4672,  lon: 54.6031,   tz: 'Asia/Dubai' },
]

function findCoords(event: ApiScheduleEvent) {
  const haystack = `${event.location} ${event.name} ${event.circuit}`.toLowerCase()
  for (const entry of CIRCUIT_COORDS) {
    if (entry.keys.some(k => haystack.includes(k))) return entry
  }
  return null
}

interface Forecast {
  conditionCode: number
  tempMax: number
  tempMin: number
  precipMm: number
  precipProbability: number
  windMax: number
  windDir: number
}

interface Props {
  nextEvent: ApiScheduleEvent
}

export default function CircuitWeather({ nextEvent }: Props) {
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [loading, setLoading] = useState(true)
  const [raceDate, setRaceDate] = useState<string | null>(null)

  useEffect(() => {
    const coords = findCoords(nextEvent)
    if (!coords) { setLoading(false); return }

    // Find race session date
    const nowMs = Date.now()
    const raceSessions = nextEvent.sessions.filter(
      (s: ApiScheduleSession) => s.session_type === 'Race' && (s.date_end ? new Date(s.date_end).getTime() > nowMs : s.is_upcoming)
    )
    const raceStart = raceSessions[0]?.date_start ?? nextEvent.date_end
    if (!raceStart) { setLoading(false); return }

    const dateStr = raceStart.slice(0, 10) // YYYY-MM-DD
    setRaceDate(dateStr)

    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.searchParams.set('latitude', String(coords.lat))
    url.searchParams.set('longitude', String(coords.lon))
    url.searchParams.set('daily', 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,windspeed_10m_max,winddirection_10m_dominant')
    url.searchParams.set('timezone', coords.tz)
    url.searchParams.set('start_date', dateStr)
    url.searchParams.set('end_date', dateStr)

    fetch(url.toString())
      .then(r => r.json())
      .then(data => {
        const d = data.daily
        if (!d || !d.weathercode?.length) return
        setForecast({
          conditionCode:     d.weathercode[0],
          tempMax:           d.temperature_2m_max[0],
          tempMin:           d.temperature_2m_min[0],
          precipMm:          d.precipitation_sum[0] ?? 0,
          precipProbability: d.precipitation_probability_max[0] ?? 0,
          windMax:           d.windspeed_10m_max[0] ?? 0,
          windDir:           d.winddirection_10m_dominant[0] ?? 0,
        })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [nextEvent])

  const coords = findCoords(nextEvent)

  if (!coords) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="font-mono text-xs text-text-dim">Circuit not found</span>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="font-mono text-xs text-text-dim tracking-widest">Loading…</span>
      </div>
    )
  }

  if (!forecast) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="font-mono text-xs text-text-dim">Forecast unavailable</span>
      </div>
    )
  }

  const { label, icon } = wmoLabel(forecast.conditionCode)
  const isWet = forecast.precipProbability >= 40 || forecast.precipMm >= 2
  const condColor = isWet ? '#0093cc' : forecast.precipProbability >= 20 ? '#ffd600' : '#00c853'

  // Wind direction cardinal
  const dirs = ['N','NE','E','SE','S','SW','W','NW']
  const windCardinal = dirs[Math.round(forecast.windDir / 45) % 8]

  // Format race date for display
  const displayDate = raceDate
    ? new Date(raceDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : '—'

  return (
    <div className="px-3 py-2 flex flex-col gap-2 h-full">

      {/* Header: condition + date */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xl leading-none">{icon}</span>
          <span
            className="font-mono text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full"
            style={{ background: `${condColor}22`, color: condColor, border: `1px solid ${condColor}55` }}
          >
            {label.toUpperCase()}
          </span>
        </div>
        <span className="font-mono text-[9px] text-text-dim">{displayDate}</span>
      </div>

      {/* Temperature */}
      <div className="flex items-end gap-3 shrink-0">
        <div className="flex flex-col">
          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">High</span>
          <span className="font-display text-xl font-black text-text-primary leading-none">
            {forecast.tempMax.toFixed(0)}°
          </span>
        </div>
        <div className="flex flex-col mb-0.5">
          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Low</span>
          <span className="font-display text-sm font-bold text-text-muted leading-none">
            {forecast.tempMin.toFixed(0)}°
          </span>
        </div>
        <div className="ml-auto flex flex-col items-end">
          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Rain chance</span>
          <span
            className="font-mono text-sm font-bold leading-none tabular-nums"
            style={{ color: condColor }}
          >
            {forecast.precipProbability}%
          </span>
        </div>
      </div>

      {/* Precipitation bar */}
      <div className="shrink-0">
        <div className="h-1 bg-border-dark rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${forecast.precipProbability}%`, background: condColor }}
          />
        </div>
        {forecast.precipMm > 0 && (
          <span className="font-mono text-[8px] text-text-dim mt-0.5 block">
            {forecast.precipMm.toFixed(1)} mm expected
          </span>
        )}
      </div>

      {/* Wind */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex flex-col">
          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Wind</span>
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-xs text-text-primary">{forecast.windMax.toFixed(0)}</span>
            <span className="font-mono text-[9px] text-text-dim">km/h</span>
            <span className="font-mono text-[9px] text-text-dim ml-1">{windCardinal}</span>
          </div>
        </div>
        <div className="ml-auto flex flex-col items-end">
          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Precip</span>
          <span className="font-mono text-xs text-text-muted tabular-nums">
            {forecast.precipMm.toFixed(1)} mm
          </span>
        </div>
      </div>

      <div className="mt-auto pt-1 border-t border-border-dark shrink-0">
        <span className="font-mono text-[8px] text-text-dim">
          {nextEvent.circuit} · Open-Meteo forecast
        </span>
      </div>
    </div>
  )
}
