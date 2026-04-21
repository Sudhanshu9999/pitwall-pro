'use client'

export const dynamic = 'force-dynamic'

import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import DashCard from '@/components/ui/DashCard'
import TrackMap from '@/components/dashboard/TrackMap'
import { fetchCompare, ApiCompareResponse, ApiLapData, loadSession } from '@/lib/api'
import { TyreCompound, SessionType } from '@/types'
import { useDashboardStore } from '@/store/dashboardStore'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYRE_COLORS: Record<TyreCompound, string> = {
  SOFT:         '#e8002d',
  MEDIUM:       '#ffd600',
  HARD:         '#f0f0f0',
  INTERMEDIATE: '#00c853',
  WET:          '#0093cc',
}

const SPEEDS = ['0.5', '1', '2', '10'] as const

const SVG_W = 320
const SVG_H = 90

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtSector(s: number | null): string {
  if (s === null) return '—'
  return s.toFixed(3)
}

function fmtLap(s: number | null): string {
  if (s === null) return '—'
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(3).padStart(6, '0')
  return `${m}:${sec}`
}

/** Format a signed lap-time delta (+0.123 or -0.456). */
function fmtDelta(s: number | null): string {
  if (s === null) return '—'
  const sign = s >= 0 ? '+' : ''
  return `${sign}${s.toFixed(3)}`
}

function buildStints(laps: ApiLapData[]): { compound: TyreCompound; start: number; end: number }[] {
  const stints: { compound: TyreCompound; start: number; end: number }[] = []
  let cur: { compound: TyreCompound; start: number; end: number } | null = null
  for (const lap of laps) {
    const c = lap.compound as TyreCompound
    if (!cur || cur.compound !== c) {
      if (cur) stints.push(cur)
      cur = { compound: c, start: lap.lap_number, end: lap.lap_number }
    } else {
      cur.end = lap.lap_number
    }
  }
  if (cur) stints.push(cur)
  return stints
}

function sectorBest(laps: ApiLapData[], key: 'sector1' | 'sector2' | 'sector3'): number | null {
  const vals = laps.map((l) => l[key]).filter((v): v is number => v !== null)
  return vals.length > 0 ? Math.min(...vals) : null
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TelBarProps {
  label: string
  valA: number
  valB: number
  max: number
  colorA: string
  colorB: string
  unit?: string
}

/** Two stacked horizontal bars — A on top, B below. */
function TelBar({ label, valA, valB, max, colorA, colorB, unit }: TelBarProps) {
  const pctA = Math.min(100, (valA / max) * 100)
  const pctB = Math.min(100, (valB / max) * 100)
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between mb-0.5">
        <span className="font-mono text-[10px] text-text-dim uppercase">{label}</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] tabular-nums" style={{ color: colorA }}>
            {Math.round(valA)}{unit}
          </span>
          <span className="font-mono text-[10px] tabular-nums" style={{ color: colorB }}>
            {Math.round(valB)}{unit}
          </span>
        </div>
      </div>
      {/* Driver A bar */}
      <div className="h-1.5 bg-border-dark rounded-sm overflow-hidden">
        <div className="h-full rounded-sm transition-all duration-300" style={{ width: `${pctA}%`, background: colorA }} />
      </div>
      {/* Driver B bar */}
      <div className="h-1.5 bg-border-dark rounded-sm overflow-hidden">
        <div className="h-full rounded-sm transition-all duration-300" style={{ width: `${pctB}%`, background: colorB }} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function CompareContent() {
  const params  = useSearchParams()
  const driverA = params.get('driverA') ?? 'VER'
  const driverB = params.get('driverB') ?? 'NOR'
  const year    = params.get('year')    ?? '—'
  const gp      = params.get('gp')     ?? '—'
  const session = params.get('session') ?? '—'

  const [data,           setData]           = useState<ApiCompareResponse | null>(null)
  const [loading,        setLoading]        = useState(true)
  const [error,          setError]          = useState<string | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)

  // Live lap accumulation: built progressively as the replay runs
  const [liveLaps, setLiveLaps] = useState<{ lap: number; a: number | null; b: number | null }[]>([])
  const trackedLapRef = useRef(0)

  const {
    activeSession, setActiveSession, setMode,
    replayPaused, replaySpeed, sendControl, setReplayPaused, setReplaySpeed,
    wsReady, currentLap, totalLaps, timing, carData,
  } = useDashboardStore()

  // ── Auto-load session + wire WebSocket ─────────────────────────────────
  useEffect(() => {
    if (year === '—' || gp === '—' || session === '—') return
    const alreadyLoaded =
      activeSession?.year === Number(year) &&
      activeSession?.gp === gp &&
      activeSession?.sessionType === session
    if (alreadyLoaded) return

    setSessionLoading(true)
    loadSession(Number(year), gp, session)
      .then(() => {
        setMode('archive')
        setActiveSession({
          year: Number(year),
          gp,
          sessionType: session as SessionType,
          driverA,
          driverB,
        })
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load session'))
      .finally(() => setSessionLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, gp, session, driverA, driverB])

  // ── Fetch static compare data (sector bests, stints, pit stops) ─────────
  useEffect(() => {
    if (year === '—' || gp === '—' || session === '—') { setLoading(false); return }
    fetchCompare(Number(year), gp, session, driverA, driverB)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load comparison'))
      .finally(() => setLoading(false))
  }, [year, gp, session, driverA, driverB])

  // ── Accumulate live lap times as the replay progresses ───────────────────
  // The backend sends current_lap=N when lap N has just been processed.
  // timing[x].lastLap in that same frame IS the lap-N time for each driver.
  useEffect(() => {
    if (currentLap <= 0) return
    if (currentLap === trackedLapRef.current) return
    trackedLapRef.current = currentLap

    const state = useDashboardStore.getState()
    const rowA = state.timing.find((r) => r.code === driverA)
    const rowB = state.timing.find((r) => r.code === driverB)

    // Only skip if BOTH drivers have no time (e.g. lap 1 standing-start NaN)
    if (rowA?.lastLap == null && rowB?.lastLap == null) return

    setLiveLaps((prev) => {
      if (prev.some((p) => p.lap === currentLap)) return prev
      return [...prev, { lap: currentLap, a: rowA?.lastLap ?? null, b: rowB?.lastLap ?? null }]
    })
  }, [currentLap, driverA, driverB])

  // ── Derived values ────────────────────────────────────────────────────────
  const colorA = data?.driverA.team_colour ?? '#e8002d'
  const colorB = data?.driverB.team_colour ?? '#ff8000'

  // Live timing rows for each driver
  const liveA = timing.find((r) => r.code === driverA)
  const liveB = timing.find((r) => r.code === driverB)

  // Live telemetry snapshots (per-lap from car_data in lap frame)
  const telA = carData[driverA]
  const telB = carData[driverB]

  // ── Static chart data (REST) ─────────────────────────────────────────────
  const staticChartData = (() => {
    if (!data) return null
    const lapsA = data.driverA.laps.filter((l) => l.lap_time !== null)
    const lapsB = data.driverB.laps.filter((l) => l.lap_time !== null)
    if (lapsA.length < 2 || lapsB.length < 2) return null
    const maxLap = Math.max(lapsA[lapsA.length - 1].lap_number, lapsB[lapsB.length - 1].lap_number)
    const allTimes = [...lapsA.map((l) => l.lap_time!), ...lapsB.map((l) => l.lap_time!)]
    const minT = Math.min(...allTimes)
    const maxT = Math.max(...allTimes)
    const range = maxT - minT || 1
    return { lapsA, lapsB, maxLap, minT, range }
  })()

  // ── Chart display mode ───────────────────────────────────────────────────
  // Once the replay is running (wsReady + at least 1 lap frame received),
  // switch to the live-building chart so the user sees it grow from left to right.
  // Before replay starts, show the static REST chart as a preview.
  const showLiveChart = wsReady && currentLap > 0

  // Y-axis reference: use static chart's range so the scale stays stable.
  // Falls back to the range of the live data itself when no static data exists.
  const chartMinT = staticChartData?.minT
  const chartRange = staticChartData?.range

  // The full X-axis span: always use totalLaps so dots appear in the right
  // proportion even before the race is finished.
  const chartMaxLap = totalLaps > 0 ? totalLaps : (staticChartData?.maxLap ?? 1)

  // ── Live chart data (accumulated during replay) ──────────────────────────
  const liveChartData = (() => {
    const valid = liveLaps.filter((l) => l.a !== null || l.b !== null)
    if (valid.length < 1) return null
    const allTimes = valid.flatMap((l) => [l.a, l.b]).filter((v): v is number => v !== null)
    // Use static chart's Y range for consistency; derive from live data when unavailable
    const minT  = chartMinT  ?? Math.min(...allTimes)
    const range = chartRange ?? (Math.max(...allTimes) - Math.min(...allTimes) || 2)
    return { valid, minT, range }
  })()

  const toStaticPath = (laps: ApiLapData[]): string => {
    if (!staticChartData) return ''
    const { maxLap, minT, range } = staticChartData
    return laps.map((l, i) => {
      const x = (l.lap_number / maxLap) * SVG_W
      const y = SVG_H - ((l.lap_time! - minT) / range) * SVG_H
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  /** SVG path for one driver's accumulated live laps. Requires 2+ valid points. */
  const toLivePath = (key: 'a' | 'b'): string => {
    if (!liveChartData) return ''
    const { valid, minT, range } = liveChartData
    const pts = valid.filter((l) => l[key] !== null)
    if (pts.length < 2) return ''
    return pts.map((l, i) => {
      const x = (l.lap / chartMaxLap) * SVG_W
      const y = SVG_H - ((l[key]! - minT) / range) * SVG_H
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  /** X coordinate for a cursor on the active chart. */
  const activeCursorX = currentLap > 0 ? (currentLap / chartMaxLap) * SVG_W : null

  // Pit stop lap numbers per driver (from REST data)
  const pitLapsA = new Set(data?.driverA.pit_stops.map((p) => p.lap_number) ?? [])
  const pitLapsB = new Set(data?.driverB.pit_stops.map((p) => p.lap_number) ?? [])

  // Per-lap delta: how much faster A was vs B on each lap (positive = A faster)
  const perLapDeltas = liveLaps
    .filter((l) => l.a !== null && l.b !== null)
    .map((l) => ({ lap: l.lap, delta: l.b! - l.a! }))  // positive = A faster

  // ── Replay controls ────────────────────────────────────────────────────────
  const handlePlayPause = () => {
    if (replayPaused) { sendControl('resume'); setReplayPaused(false) }
    else              { sendControl('pause');  setReplayPaused(true)  }
  }

  const handleSpeed = (s: '0.5' | '1' | '2' | '10') => {
    setReplaySpeed(s)
    sendControl('speed', s)
  }

  // ── Sector delta with winner ──────────────────────────────────────────────
  const sectorRows = (['sector1', 'sector2', 'sector3'] as const).map((key, i) => {
    const bestA = data ? sectorBest(data.driverA.laps, key) : null
    const bestB = data ? sectorBest(data.driverB.laps, key) : null
    const aWins = bestA !== null && bestB !== null && bestA < bestB
    const bWins = bestA !== null && bestB !== null && bestB < bestA
    return { key, i, bestA, bestB, aWins, bWins }
  })

  return (
    <>
      {/* ── Session info bar ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-dark bg-bg-secondary shrink-0">
        <span className="font-mono text-xs text-text-dim">
          {year} · {gp} · {session}
        </span>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: colorA }} />
            <span className="font-mono text-xs" style={{ color: colorA }}>{driverA}</span>
          </div>
          <span className="font-mono text-xs text-text-dim">vs</span>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: colorB }} />
            <span className="font-mono text-xs" style={{ color: colorB }}>{driverB}</span>
          </div>
        </div>
      </div>

      {/* ── Replay controls ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-dark bg-bg-primary shrink-0">
        {sessionLoading && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border border-text-dim border-t-f1-red rounded-full animate-spin" />
            <span className="font-mono text-xs text-text-dim">Loading session…</span>
          </div>
        )}

        <button
          onClick={handlePlayPause}
          disabled={!wsReady || sessionLoading}
          className="flex items-center justify-center w-7 h-7 border border-border-dark hover:border-border-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={replayPaused ? 'Play' : 'Pause'}
        >
          {replayPaused ? (
            <svg viewBox="0 0 10 10" className="w-3 h-3 fill-text-primary">
              <polygon points="2,1 9,5 2,9" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" className="w-3 h-3 fill-text-primary">
              <rect x="1.5" y="1" width="3" height="8" />
              <rect x="5.5" y="1" width="3" height="8" />
            </svg>
          )}
        </button>

        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => handleSpeed(s)}
              disabled={!wsReady || sessionLoading}
              className={`font-mono text-[10px] px-1.5 py-0.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                replaySpeed === s
                  ? 'border-f1-red text-f1-red'
                  : 'border-border-dark text-text-dim hover:border-border-accent hover:text-text-muted'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* Lap counter + live delta badge */}
        <div className="ml-auto flex items-center gap-3">
          {wsReady && liveA && liveB && liveA.lastLap && liveB.lastLap && (
            <span
              className="font-mono text-[10px] px-1.5 py-0.5 border"
              style={{
                color:        liveA.lastLap <= liveB.lastLap ? colorA : colorB,
                borderColor:  liveA.lastLap <= liveB.lastLap ? colorA : colorB,
              }}
            >
              Δ {fmtDelta(liveA.lastLap - liveB.lastLap)}
            </span>
          )}
          <span className="font-mono text-xs text-text-dim">
            {wsReady && currentLap > 0
              ? `LAP ${currentLap}${totalLaps > 0 ? ` / ${totalLaps}` : ''}`
              : sessionLoading ? 'Loading…' : 'Waiting for stream'}
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${wsReady ? 'bg-flag-green' : 'bg-text-dim'}`}
            title={wsReady ? 'Connected' : 'Not connected'}
          />
        </div>
      </div>

      {/* ── Driver banner ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 border-b border-border-dark shrink-0">
        {/* Driver A */}
        <div className="px-6 py-3 border-r border-border-dark" style={{ borderTop: `2px solid ${colorA}` }}>
          <div className="flex items-baseline gap-3">
            <span className="font-display text-3xl sm:text-4xl font-black tracking-widest" style={{ color: colorA }}>
              {driverA}
            </span>
            {liveA && (
              <span className="font-mono text-xs text-text-dim">P{liveA.position}</span>
            )}
          </div>
          {data && <p className="font-mono text-[10px] text-text-dim mt-0.5">{data.driverA.team_name}</p>}
          {liveA ? (
            <div className="flex items-center gap-3 mt-1">
              <span className="font-mono text-xs text-text-muted">{liveA.gap}</span>
              <span className="font-mono text-xs" style={{ color: colorA }}>
                {fmtLap(liveA.lastLap)}
              </span>
              <span
                className="font-mono text-[10px] px-1 py-0.5"
                style={{ color: TYRE_COLORS[liveA.compound] ?? '#888', border: `1px solid ${TYRE_COLORS[liveA.compound] ?? '#888'}` }}
              >
                {liveA.compound[0]} {liveA.tyreAge}L
              </span>
            </div>
          ) : data ? (
            <p className="font-mono text-[10px] text-text-dim mt-1">
              Best: {fmtLap(data.driverA.best_lap)}
            </p>
          ) : null}
        </div>

        {/* Driver B */}
        <div className="px-6 py-3" style={{ borderTop: `2px solid ${colorB}` }}>
          <div className="flex items-baseline gap-3">
            <span className="font-display text-3xl sm:text-4xl font-black tracking-widest" style={{ color: colorB }}>
              {driverB}
            </span>
            {liveB && (
              <span className="font-mono text-xs text-text-dim">P{liveB.position}</span>
            )}
          </div>
          {data && <p className="font-mono text-[10px] text-text-dim mt-0.5">{data.driverB.team_name}</p>}
          {liveB ? (
            <div className="flex items-center gap-3 mt-1">
              <span className="font-mono text-xs text-text-muted">{liveB.gap}</span>
              <span className="font-mono text-xs" style={{ color: colorB }}>
                {fmtLap(liveB.lastLap)}
              </span>
              <span
                className="font-mono text-[10px] px-1 py-0.5"
                style={{ color: TYRE_COLORS[liveB.compound] ?? '#888', border: `1px solid ${TYRE_COLORS[liveB.compound] ?? '#888'}` }}
              >
                {liveB.compound[0]} {liveB.tyreAge}L
              </span>
            </div>
          ) : data ? (
            <p className="font-mono text-[10px] text-text-dim mt-1">
              Best: {fmtLap(data.driverB.best_lap)}
            </p>
          ) : null}
        </div>
      </div>

      {/* ── Main grid ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">

        {/* Top row */}
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 border-b border-border-dark min-h-0">

          {/* Lap Time Delta chart */}
          <div className="border-r border-border-dark">
            <DashCard
              title="Lap Time Delta"
              tag={showLiveChart ? `${driverA} vs ${driverB} · LIVE` : `${driverA} vs ${driverB}`}
              accent={colorA}
              className="h-full"
            >
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="w-4 h-4 border border-text-dim border-t-f1-red rounded-full animate-spin" />
                </div>
              ) : error ? (
                <div className="flex items-center justify-center h-full p-4">
                  <span className="font-mono text-xs text-f1-red text-center">{error}</span>
                </div>
              ) : (staticChartData || showLiveChart) ? (
                <div className="flex flex-col h-full p-3 gap-2">
                  {/* Legend */}
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-px" style={{ background: colorA }} />
                      <span className="font-mono text-[10px] text-text-dim">{driverA}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-5 h-px" style={{ background: colorB }} />
                      <span className="font-mono text-[10px] text-text-dim">{driverB}</span>
                    </div>
                    {showLiveChart && (
                      <span className="font-mono text-[9px] text-flag-green ml-auto animate-pulse">● LIVE</span>
                    )}
                  </div>

                  {/* SVG chart */}
                  <div className="flex-1 flex items-center">
                    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" preserveAspectRatio="none">

                      {/* Static REST lines — always shown; faded when live replay is active */}
                      {staticChartData && (() => {
                        const opacity = showLiveChart ? 0.2 : 1
                        const { maxLap, minT, range } = staticChartData
                        const toPx = (l: ApiLapData) => ({
                          x: (l.lap_number / chartMaxLap) * SVG_W,
                          y: SVG_H - ((l.lap_time! - minT) / range) * SVG_H,
                        })
                        return (
                          <>
                            {/* Pit stop markers */}
                            {data?.driverA.pit_stops.map((ps) => (
                              <line key={`pitA-${ps.lap_number}`}
                                x1={(ps.lap_number / chartMaxLap) * SVG_W} y1={0}
                                x2={(ps.lap_number / chartMaxLap) * SVG_W} y2={SVG_H}
                                stroke={colorA} strokeWidth="0.5" strokeDasharray="2,3" opacity={opacity * 0.5} />
                            ))}
                            {data?.driverB.pit_stops.map((ps) => (
                              <line key={`pitB-${ps.lap_number}`}
                                x1={(ps.lap_number / chartMaxLap) * SVG_W} y1={0}
                                x2={(ps.lap_number / chartMaxLap) * SVG_W} y2={SVG_H}
                                stroke={colorB} strokeWidth="0.5" strokeDasharray="2,3" opacity={opacity * 0.5} />
                            ))}
                            <path d={toStaticPath(staticChartData.lapsA)} fill="none" stroke={colorA} strokeWidth="1.5" opacity={opacity} />
                            <path d={toStaticPath(staticChartData.lapsB)} fill="none" stroke={colorB} strokeWidth="1.5" opacity={opacity} />
                            {/* Best lap dots */}
                            {!showLiveChart && data && (() => {
                              const bestA = data.driverA.best_lap
                              const bestB = data.driverB.best_lap
                              const lapA = bestA ? staticChartData.lapsA.find((l) => Math.abs(l.lap_time! - bestA) < 0.001) : null
                              const lapB = bestB ? staticChartData.lapsB.find((l) => Math.abs(l.lap_time! - bestB) < 0.001) : null
                              return (
                                <>
                                  {lapA && <circle cx={toPx(lapA).x} cy={toPx(lapA).y} r="3" fill={colorA} />}
                                  {lapB && <circle cx={toPx(lapB).x} cy={toPx(lapB).y} r="3" fill={colorB} />}
                                </>
                              )
                            })()}
                          </>
                        )
                      })()}

                      {/* Live-building overlay — grows each lap during replay */}
                      {showLiveChart && liveChartData && (() => {
                        const { valid, minT, range } = liveChartData
                        const ptsA = valid.filter((l) => l.a !== null)
                        const ptsB = valid.filter((l) => l.b !== null)
                        const toXY = (l: { lap: number; a: number | null; b: number | null }, key: 'a' | 'b') => ({
                          x: (l.lap / chartMaxLap) * SVG_W,
                          y: SVG_H - ((l[key]! - minT) / range) * SVG_H,
                        })
                        return (
                          <>
                            {/* Lines (need 2+ points) */}
                            {ptsA.length >= 2 && (
                              <path d={toLivePath('a')} fill="none" stroke={colorA} strokeWidth="2" />
                            )}
                            {ptsB.length >= 2 && (
                              <path d={toLivePath('b')} fill="none" stroke={colorB} strokeWidth="2" />
                            )}
                            {/* Dots for every recorded lap */}
                            {ptsA.map((l) => {
                              const { x, y } = toXY(l, 'a')
                              return <circle key={`la-${l.lap}`} cx={x} cy={y} r="2.5" fill={colorA} />
                            })}
                            {ptsB.map((l) => {
                              const { x, y } = toXY(l, 'b')
                              return <circle key={`lb-${l.lap}`} cx={x} cy={y} r="2.5" fill={colorB} />
                            })}
                          </>
                        )
                      })()}

                      {/* "Waiting for first lap" message when live but no data yet */}
                      {showLiveChart && !liveChartData && (
                        <text x={SVG_W / 2} y={SVG_H / 2} textAnchor="middle"
                          fill="rgba(255,255,255,0.2)" fontSize="9" fontFamily="monospace">
                          Waiting for lap 1…
                        </text>
                      )}

                      {/* Current lap cursor */}
                      {activeCursorX !== null && (
                        <line x1={activeCursorX} y1={0} x2={activeCursorX} y2={SVG_H}
                          stroke="rgba(255,255,255,0.5)" strokeWidth="1" strokeDasharray="3,2" />
                      )}
                    </svg>
                  </div>

                  {/* Best lap summary */}
                  {data && (
                    <div className="flex items-center gap-6 shrink-0">
                      <span className="font-mono text-[10px]" style={{ color: colorA }}>
                        ● Best: {fmtLap(data.driverA.best_lap)}
                      </span>
                      <span className="font-mono text-[10px]" style={{ color: colorB }}>
                        ● Best: {fmtLap(data.driverB.best_lap)}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <span className="font-mono text-xs text-text-dim">Load a session to see delta</span>
                </div>
              )}
            </DashCard>
          </div>

          {/* Track Map — filtered to show only the two selected drivers */}
          <DashCard title="Track Map" tag="POSITION OVERLAY" accent="#ff8000" className="h-full">
            <TrackMap filterDrivers={[driverA, driverB]} />
          </DashCard>
        </div>

        {/* Bottom row — 4 analysis cards */}
        <div
          className="grid grid-cols-2 lg:grid-cols-4 border-t border-border-dark shrink-0"
          style={{ height: '220px' }}
        >

          {/* Telemetry Overlay — real-time speed / throttle / brake bars */}
          <DashCard
            title="Telemetry"
            tag="SPD · THR · BRK"
            accent={colorA}
            className="h-full border-r border-border-dark"
          >
            <div className="flex flex-col justify-center h-full px-3 gap-3">
              {telA || telB ? (
                <>
                  {/* Driver label row */}
                  <div className="flex items-center justify-end gap-4 mb-1">
                    <span className="font-mono text-[9px] uppercase" style={{ color: colorA }}>{driverA}</span>
                    <span className="font-mono text-[9px] uppercase" style={{ color: colorB }}>{driverB}</span>
                  </div>
                  <TelBar
                    label="Speed"
                    valA={telA?.speed  ?? 0}
                    valB={telB?.speed  ?? 0}
                    max={340}
                    colorA={colorA}
                    colorB={colorB}
                    unit=" km/h"
                  />
                  <TelBar
                    label="Throttle"
                    valA={telA?.throttle ?? 0}
                    valB={telB?.throttle ?? 0}
                    max={100}
                    colorA={colorA}
                    colorB={colorB}
                    unit="%"
                  />
                  <TelBar
                    label="Brake"
                    valA={telA?.brake ?? 0}
                    valB={telB?.brake ?? 0}
                    max={100}
                    colorA={colorA}
                    colorB={colorB}
                    unit="%"
                  />
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] text-text-dim uppercase">Gear</span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-[10px] tabular-nums" style={{ color: colorA }}>
                        {telA?.gear ?? '—'}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums" style={{ color: colorB }}>
                        {telB?.gear ?? '—'}
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2">
                  <span className="font-mono text-xs text-text-dim">
                    {wsReady ? 'Awaiting lap data…' : 'Press Play to start'}
                  </span>
                </div>
              )}
            </div>
          </DashCard>

          {/* Per-lap delta bars — who was faster on each lap */}
          <DashCard
            title="Lap Delta"
            tag="PER-LAP WINNER"
            accent="#ffd600"
            className="h-full border-r border-border-dark"
          >
            <div className="flex flex-col h-full px-3 py-2 gap-1 overflow-y-auto">
              {perLapDeltas.length > 0 ? (
                <>
                  {/* Scale header */}
                  <div className="flex items-center justify-between shrink-0 mb-1">
                    <span className="font-mono text-[9px]" style={{ color: colorA }}>{driverA} faster ←</span>
                    <span className="font-mono text-[9px]" style={{ color: colorB }}>→ {driverB} faster</span>
                  </div>
                  {/* Bars */}
                  {perLapDeltas.map(({ lap, delta }) => {
                    const maxDelta = Math.max(...perLapDeltas.map((d) => Math.abs(d.delta)), 0.5)
                    const pct = Math.min(100, (Math.abs(delta) / maxDelta) * 50)
                    const aFaster = delta >= 0
                    const isPit = pitLapsA.has(lap) || pitLapsB.has(lap)
                    return (
                      <div key={lap} className="flex items-center gap-1 shrink-0" style={{ height: '12px' }}>
                        <span className="font-mono text-[8px] text-text-dim w-5 text-right shrink-0">{lap}</span>
                        {/* Centre line at 50% */}
                        <div className="flex-1 flex items-center relative h-full">
                          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-dark" />
                          {aFaster ? (
                            <div
                              className="absolute h-2 rounded-sm"
                              style={{
                                background: isPit ? '#666' : colorA,
                                width: `${pct}%`,
                                right: '50%',
                                opacity: isPit ? 0.4 : 0.8,
                              }}
                            />
                          ) : (
                            <div
                              className="absolute h-2 rounded-sm"
                              style={{
                                background: isPit ? '#666' : colorB,
                                width: `${pct}%`,
                                left: '50%',
                                opacity: isPit ? 0.4 : 0.8,
                              }}
                            />
                          )}
                        </div>
                        <span className="font-mono text-[8px] text-text-dim w-10 shrink-0">
                          {fmtDelta(delta)}
                        </span>
                      </div>
                    )
                  })}
                </>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <span className="font-mono text-xs text-text-dim">Builds during replay</span>
                </div>
              )}
            </div>
          </DashCard>

          {/* Sector Delta — best sector times with winner highlight */}
          <DashCard
            title="Sector Delta"
            tag="S1 · S2 · S3"
            accent="#ffd600"
            className="h-full border-r border-border-dark"
          >
            <div className="flex flex-col justify-center h-full px-3 gap-3">
              {/* Header */}
              <div className="flex items-center justify-between">
                <span className="font-mono text-[9px] text-text-dim">Sector</span>
                <div className="flex gap-3">
                  <span className="font-mono text-[9px] w-16 text-right" style={{ color: colorA }}>{driverA}</span>
                  <span className="font-mono text-[9px] w-16 text-right" style={{ color: colorB }}>{driverB}</span>
                </div>
              </div>
              {sectorRows.map(({ key, i, bestA, bestB, aWins, bWins }) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="font-mono text-xs text-text-dim">S{i + 1}</span>
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-mono text-xs w-16 text-right ${aWins ? 'font-bold' : ''}`}
                      style={{ color: aWins ? colorA : 'var(--color-text-muted, #888)' }}
                    >
                      {fmtSector(bestA)}
                    </span>
                    <span
                      className={`font-mono text-xs w-16 text-right ${bWins ? 'font-bold' : ''}`}
                      style={{ color: bWins ? colorB : 'var(--color-text-muted, #888)' }}
                    >
                      {fmtSector(bestB)}
                    </span>
                  </div>
                </div>
              ))}
              {!data && <span className="font-mono text-xs text-text-dim mt-2">Load session first</span>}
            </div>
          </DashCard>

          {/* Tyre Strategy */}
          <DashCard title="Tyre Strategy" tag="STINTS" accent="#00c853" className="h-full">
            <div className="flex flex-col justify-center h-full px-3 gap-4">
              {data ? (
                [
                  { d: driverA, c: colorA, laps: data.driverA.laps },
                  { d: driverB, c: colorB, laps: data.driverB.laps },
                ].map(({ d, c, laps }) => {
                  const stints   = buildStints(laps)
                  const lapCount = laps.length || 1
                  const liveRow  = d === driverA ? liveA : liveB
                  return (
                    <div key={d} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[10px]" style={{ color: c }}>{d}</span>
                        {liveRow && (
                          <span className="font-mono text-[9px] text-text-dim">
                            {liveRow.compound[0]} · {liveRow.tyreAge}L
                          </span>
                        )}
                      </div>
                      <div className="flex h-4 bg-border-dark rounded-sm overflow-hidden">
                        {stints.map((s, i) => (
                          <div
                            key={i}
                            className="h-full"
                            style={{
                              width:      `${((s.end - s.start + 1) / lapCount) * 100}%`,
                              background: TYRE_COLORS[s.compound] ?? '#555',
                              opacity:    0.75,
                            }}
                            title={`${s.compound} L${s.start}–${s.end}`}
                          />
                        ))}
                        {/* Highlight current position in the stint */}
                        {liveRow && currentLap > 0 && (
                          <div
                            className="absolute top-0 bottom-0 w-px bg-white opacity-60 pointer-events-none"
                            style={{ left: `${(currentLap / lapCount) * 100}%` }}
                          />
                        )}
                      </div>
                    </div>
                  )
                })
              ) : (
                [{ d: driverA, c: colorA }, { d: driverB, c: colorB }].map(({ d, c }) => (
                  <div key={d} className="flex items-center gap-2">
                    <span className="font-mono text-xs w-8" style={{ color: c }}>{d}</span>
                    <div className="flex-1 h-4 bg-border-dark rounded-sm" />
                  </div>
                ))
              )}
              {!data && <span className="font-mono text-xs text-text-dim">Session required</span>}
            </div>
          </DashCard>

        </div>
      </div>
    </>
  )
}

export default function ComparePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center flex-1">
          <div className="flex flex-col items-center gap-3">
            <div className="w-6 h-6 border border-text-dim border-t-f1-red rounded-full animate-spin" />
            <span className="font-mono text-xs text-text-dim tracking-widest uppercase">Loading</span>
          </div>
        </div>
      }
    >
      <CompareContent />
    </Suspense>
  )
}
