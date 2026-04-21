'use client'

import { useState, useEffect, Suspense } from 'react'
import DriverPicker from '@/components/dashboard/DriverPicker'
import { useRouter } from 'next/navigation'
import DashCard from '@/components/ui/DashCard'
import TimingTower from '@/components/dashboard/TimingTower'
import TrackMap from '@/components/dashboard/TrackMap'
import UpcomingGP from '@/components/dashboard/UpcomingGP'
import RaceControl from '@/components/dashboard/RaceControl'
import CircuitWeather from '@/components/dashboard/CircuitWeather'
import { useDashboardStore } from '@/store/dashboardStore'
import { fetchLastRace, fetchStandings, fetchSchedule, ApiLastRaceResponse, ApiStandingsResponse, ApiScheduleEvent } from '@/lib/api'
import { TyreCompound } from '@/types'

const TYRE_COLOR: Record<TyreCompound, string> = {
  SOFT: '#e8002d',
  MEDIUM: '#ffd600',
  HARD: '#f0f0f0',
  INTERMEDIATE: '#00c853',
  WET: '#0093cc',
}

// Expected max laps per compound (F1 typical — used for normalized wear %)
const COMPOUND_LIFE: Record<TyreCompound, number> = {
  SOFT: 28,
  MEDIUM: 45,
  HARD: 62,
  INTERMEDIATE: 35,
  WET: 40,
}

function tyreWearPct(compound: TyreCompound, age: number): number {
  return Math.min(100, (age / (COMPOUND_LIFE[compound] ?? 40)) * 100)
}

function wearColor(pct: number): string {
  if (pct >= 85) return '#e8002d'
  if (pct >= 65) return '#ff8000'
  if (pct >= 42) return '#ffd600'
  return '#00c853'
}

function DashboardContent() {
  const router = useRouter()
  const {
    mode, activeSession, setShowSelector,
    timing, weather, tyreDeg, ersResults, undercutResults, currentLap,
    carData, raceControl, trackStatus, sessionLabel,
    wsReady, replaySpeed, replayPaused,
    hasTelemetry, lastSectors, bestSectors,
    setReplaySpeed, setReplayPaused, sendControl,
  } = useDashboardStore()

  const isLiveSession = mode === 'live' && wsReady
  const [showDriverPicker, setShowDriverPicker] = useState(false)
  const [mobileTab, setMobileTab] = useState<'timing' | 'track'>('timing')

  // ── Last Race + Standings + Schedule (fetched only when no live session) ──
  const [lastRace, setLastRace] = useState<ApiLastRaceResponse | null>(null)
  const [standings, setStandings] = useState<ApiStandingsResponse | null>(null)
  const [nextEvent, setNextEvent] = useState<ApiScheduleEvent | null>(null)
  const [standingsLoading, setStandingsLoading] = useState(false)
  const [lastRaceLoading, setLastRaceLoading] = useState(false)

  useEffect(() => {
    if (mode !== 'live' || isLiveSession) return
    setLastRaceLoading(true)
    setStandingsLoading(true)
    fetchLastRace()
      .then(setLastRace)
      .catch(() => setLastRace(null))
      .finally(() => setLastRaceLoading(false))
    fetchStandings()
      .then(setStandings)
      .catch(() => setStandings(null))
      .finally(() => setStandingsLoading(false))
    fetchSchedule()
      .then(res => setNextEvent(res.next_event))
      .catch(() => setNextEvent(null))
  }, [mode, isLiveSession])

  const handleSpeedChange = (speed: '0.5' | '1' | '2' | '10') => {
    setReplaySpeed(speed)
    sendControl('speed', speed)
  }

  const handlePlayPause = () => {
    if (replayPaused) {
      setReplayPaused(false)
      sendControl('resume')
    } else {
      setReplayPaused(true)
      sendControl('pause')
    }
  }

  // Selected driver: driverA from activeSession (archive) or race leader (live)
  const selectedCode = (mode === 'archive' ? activeSession?.driverA : undefined) ?? timing[0]?.code
  const selectedRow = timing.find(r => r.code === selectedCode) ?? timing[0]

  // Tyre deg for selected driver + their current compound
  const selectedDeg = tyreDeg.find(r =>
    r.driverCode === selectedCode && r.compound === selectedRow?.compound
  ) ?? tyreDeg.find(r => r.driverCode === selectedCode) ?? tyreDeg[0]

  const degCurve = selectedDeg?.predictedCurve

  // Build SVG polyline + current-position dot for the tyre deg curve
  function buildDegSvg(W: number, H: number) {
    if (!degCurve || degCurve.length < 2 || !selectedRow) return null
    const ages  = degCurve.map(p => p.tyreAge)
    const times = degCurve.map(p => p.predictedLapTime)
    const minA = Math.min(...ages),  maxA = Math.max(...ages)
    const minT = Math.min(...times), maxT = Math.max(...times)
    const rangeA = maxA - minA || 1
    const rangeT = maxT - minT || 0.001
    const toX = (a: number) => ((a - minA) / rangeA) * W
    const toY = (t: number) => H - ((t - minT) / rangeT) * H

    const pts = degCurve.map(p => `${toX(p.tyreAge).toFixed(1)},${toY(p.predictedLapTime).toFixed(1)}`).join(' ')
    const dotX = toX(selectedRow.tyreAge)
    const dotY = toY(degCurve.find(p => p.tyreAge === selectedRow.tyreAge)?.predictedLapTime ?? times[0])
    const tyreColor = TYRE_COLOR[selectedRow.compound] ?? '#888'

    return { pts, dotX, dotY, tyreColor, minA, maxA, minT, maxT }
  }

  const topUndercut = undercutResults[0]
  const selectedErs = ersResults.find(e => e.driverCode === selectedCode) ?? ersResults[0]
  const selectedTel = selectedCode ? carData[selectedCode] : undefined

  const race = lastRace?.race

  return (
    <>
      {/* LIVE — NO SESSION */}
      {mode === 'live' && !isLiveSession && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 border-b border-border-dark overflow-hidden">
            <DashCard title="Next Grand Prix" accent="#e8002d" status="live" className="h-full">
              <UpcomingGP />
            </DashCard>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:h-[220px] border-t border-border-dark">
            {/* Last Race Results */}
            <div className="min-h-[180px] lg:min-h-0 lg:flex-1 border-b sm:border-b-0 border-r border-border-dark">
              <DashCard title="Last Race Results" tag="RESULTS" accent="#ff8000" className="h-full">
                {lastRaceLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="font-mono text-xs text-text-dim tracking-widest">Loading…</span>
                  </div>
                ) : !race ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="font-mono text-xs text-text-dim">Unavailable</span>
                  </div>
                ) : (
                  <div className="p-3 flex flex-col h-full">
                    <p className="font-display text-xs font-semibold text-text-primary uppercase tracking-wider mb-2">{race.name}</p>
                    <p className="font-mono text-[10px] text-text-dim mb-3">{race.circuit} · Rd {race.round}</p>
                    <div className="flex flex-col gap-1.5 flex-1">
                      {race.podium.slice(0, 3).map((p) => (
                        <div key={p.position} className="flex items-center gap-2">
                          <span className="font-mono text-xs text-text-dim w-4">{p.position}</span>
                          <span className="font-display text-xs font-bold text-text-primary w-8">{p.code}</span>
                          <span className="font-mono text-[10px] text-text-dim flex-1 truncate">{p.team}</span>
                          {p.time && <span className="font-mono text-[10px] text-text-muted">{p.time}</span>}
                        </div>
                      ))}
                      {race.fastest_lap && (
                        <div className="flex items-center gap-2 mt-1 pt-1.5 border-t border-border-dark">
                          <span className="font-mono text-[9px] text-flag-green tracking-widest uppercase">FL</span>
                          <span className="font-display text-xs font-bold text-text-primary">{race.fastest_lap.code}</span>
                          <span className="font-mono text-[10px] text-text-dim">{race.fastest_lap.time}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </DashCard>
            </div>

            {/* Championship Standings */}
            <div className="min-h-[180px] lg:min-h-0 lg:flex-1 border-b sm:border-b-0 border-r border-border-dark overflow-hidden">
              <DashCard title="Championship Standings" tag="WDC · WCC" accent="#ffd600" className="h-full">
                {standingsLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="font-mono text-xs text-text-dim tracking-widest">Loading…</span>
                  </div>
                ) : !standings ? (
                  <div className="flex items-center justify-center h-full">
                    <span className="font-mono text-xs text-text-dim">Unavailable</span>
                  </div>
                ) : (
                  <div className="p-3 flex gap-4 h-full overflow-hidden">
                    {/* Drivers */}
                    <div className="flex-1 flex flex-col gap-1 overflow-hidden">
                      <span className="font-mono text-[9px] text-text-dim tracking-widest uppercase mb-1">Drivers</span>
                      {standings.drivers.slice(0, 5).map((d) => (
                        <div key={d.code} className="flex items-center gap-1.5">
                          <span className="font-mono text-[9px] text-text-dim w-3">{d.position}</span>
                          <span className="font-display text-[10px] font-bold text-text-primary w-7">{d.code}</span>
                          <span className="font-mono text-[9px] text-f1-red ml-auto">{d.points}</span>
                        </div>
                      ))}
                    </div>
                    {/* Constructors */}
                    <div className="flex-1 flex flex-col gap-1 overflow-hidden">
                      <span className="font-mono text-[9px] text-text-dim tracking-widest uppercase mb-1">Teams</span>
                      {standings.constructors.slice(0, 5).map((c) => (
                        <div key={c.name} className="flex items-center gap-1.5">
                          <span className="font-mono text-[9px] text-text-dim w-3">{c.position}</span>
                          <span className="font-mono text-[10px] text-text-primary flex-1 truncate">{c.name}</span>
                          <span className="font-mono text-[9px] text-f1-red">{c.points}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </DashCard>
            </div>

            {/* Race day weather forecast */}
            <div className="sm:col-span-2 lg:col-span-1 min-h-[180px] lg:min-h-0 lg:w-72">
              <DashCard title="Race Day Weather" tag="FORECAST" accent="#00bcd4" className="h-full">
                {nextEvent
                  ? <CircuitWeather nextEvent={nextEvent} />
                  : <div className="flex items-center justify-center h-full"><span className="font-mono text-xs text-text-dim">Loading…</span></div>
                }
              </DashCard>
            </div>
          </div>
        </div>
      )}

      {/* ARCHIVE — NOTHING SELECTED */}
      {mode === 'archive' && !activeSession && (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <span className="font-mono text-xs text-text-dim tracking-widest uppercase">No session selected</span>
          <button
            onClick={() => setShowSelector(true)}
            className="px-8 py-3 bg-f1-red text-white font-display text-xs font-bold tracking-widest uppercase hover:bg-f1-red-bright transition-colors"
          >
            Select Session →
          </button>
        </div>
      )}

      {/* MAIN DASHBOARD — session loaded (archive) or live session active */}
      {(isLiveSession || (mode === 'archive' && activeSession)) && (
        <div className="flex-1 overflow-y-auto md:overflow-hidden flex flex-col">

          {/* Live session banner */}
          {isLiveSession && sessionLabel && (
            <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-bg-secondary border-b border-f1-red">
              <span className="w-2 h-2 rounded-full bg-f1-red animate-pulse shrink-0" />
              <span className="font-mono text-xs text-f1-red tracking-widest uppercase shrink-0">Live</span>
              <span className="font-mono text-xs text-text-muted truncate">{sessionLabel}</span>
              <span className="font-mono text-xs text-text-dim ml-auto shrink-0 hidden sm:block">Full telemetry in Archive mode after session ends</span>
            </div>
          )}

          {/* Replay controls (archive only) */}
          {mode === 'archive' && activeSession && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-border-dark bg-bg-secondary shrink-0">
              <span className="font-mono text-xs text-text-dim mr-auto">
                {activeSession.year} · {activeSession.gp} · {activeSession.sessionType}
              </span>
              <div className="flex items-center flex-wrap gap-1.5">
                <button
                  onClick={() => setShowDriverPicker(true)}
                  className="font-mono text-xs text-text-dim hover:text-text-muted border border-border-dark px-2 py-1 transition-colors hover:border-f1-red hover:text-f1-red"
                >
                  Compare
                </button>
                <button
                  onClick={() => setShowSelector(true)}
                  className="font-mono text-xs text-text-dim hover:text-text-muted border border-border-dark px-2 py-1 transition-colors"
                >
                  Change
                </button>
                {(['0.5x', '1x', '2x', '10x'] as const).map(label => {
                  const val = label.replace('x', '') as '0.5' | '1' | '2' | '10'
                  return (
                    <button
                      key={label}
                      onClick={() => handleSpeedChange(val)}
                      className={`font-mono text-xs px-2.5 py-1 border transition-colors ${
                        replaySpeed === val
                          ? 'border-f1-red text-f1-red'
                          : 'border-border-dark text-text-dim hover:border-border-accent'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
                <button
                  onClick={handlePlayPause}
                  disabled={!wsReady}
                  className={`font-mono text-xs px-3 py-1 transition-colors ${
                    wsReady
                      ? 'bg-f1-red text-white hover:bg-f1-red-bright'
                      : 'bg-border-dark text-text-dim cursor-not-allowed'
                  }`}
                >
                  {!wsReady ? '⌛ Loading…' : replayPaused ? '▶ Play' : '⏸ Pause'}
                </button>
              </div>
            </div>
          )}

          {/* Mobile tab bar — Timing | Track (hidden on md+) */}
          {!isLiveSession && (
            <div className="flex md:hidden border-b border-border-dark shrink-0">
              {(['timing', 'track'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setMobileTab(tab)}
                  className={`flex-1 py-2 font-mono text-[10px] tracking-widest uppercase transition-colors ${
                    mobileTab === tab
                      ? 'text-f1-red border-b border-f1-red'
                      : 'text-text-dim hover:text-text-muted'
                  }`}
                >
                  {tab === 'timing' ? 'Timing' : 'Track Map'}
                </button>
              ))}
            </div>
          )}

          {/* Main grid top row */}
          <div className="grid grid-cols-1 md:grid-cols-3 md:flex-1 md:min-h-0 border-b border-border-dark md:overflow-hidden">
            {/* Timing Tower — always visible on md+; on mobile only when mobileTab=timing */}
            <div className={`border-r border-border-dark flex flex-col overflow-hidden ${mobileTab === 'timing' ? 'flex' : 'hidden'} md:flex`}>
              <DashCard
                title="Timing Tower"
                tag={currentLap > 0 ? `LAP ${currentLap}` : 'LAP —'}
                accent="#e8002d"
                status={mode === 'live' ? 'live' : 'ready'}
                className="h-full"
              >
                <TimingTower rows={timing} />
              </DashCard>
            </div>

            {/* Middle column: Race Control in live, Track Map in archive */}
            <div className={`min-h-[300px] md:min-h-0 border-b md:border-b-0 border-r border-border-dark flex flex-col overflow-hidden ${isLiveSession || mobileTab === 'track' ? 'flex' : 'hidden'} md:flex`}>
              {isLiveSession ? (
                <DashCard title="Race Control" tag="MESSAGES" accent="#ff8000" status="live" className="h-full">
                  <RaceControl messages={raceControl} trackStatus={trackStatus} />
                </DashCard>
              ) : (
                <DashCard title="Track Map" tag="POSITION" accent="#ff8000" status="ready" className="h-full">
                  <TrackMap />
                </DashCard>
              )}
            </div>

            <div className="flex flex-col divide-y divide-border-dark md:overflow-hidden">
              {/* Tyre Status — all drivers, compound-normalised wear */}
              <DashCard
                title="Tyre Status"
                tag="GRIP · ALL DRIVERS"
                accent="#ffd600"
                status="ready"
                className="flex-[2] min-h-[280px] md:min-h-0"
              >
                {timing.length === 0 ? (
                  <div className="flex items-center justify-center flex-1">
                    <span className="font-mono text-xs text-text-dim">Awaiting data…</span>
                  </div>
                ) : (
                  <div className="flex flex-col h-full overflow-hidden">
                    {/* Deg curve for selected driver (compact, top) */}
                    {(() => {
                      const svgData = buildDegSvg(200, 52)
                      const tyreColor = selectedRow ? (TYRE_COLOR[selectedRow.compound] ?? '#888') : '#888'
                      if (!svgData || !selectedRow) return null
                      return (
                        <div className="px-3 pt-2 pb-1 border-b border-border-dark shrink-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tyreColor }} />
                            <span className="font-display text-[10px] font-bold tracking-wider" style={{ color: tyreColor }}>
                              {selectedRow.code} · {selectedRow.compound}
                            </span>
                            <span className="font-mono text-[9px] text-text-dim ml-auto">
                              {selectedRow.tyreAge}L · R²={selectedDeg?.rSquared.toFixed(2) ?? '—'}
                            </span>
                          </div>
                          <svg viewBox="0 0 200 52" className="w-full" style={{ height: 40 }} preserveAspectRatio="none">
                            <polyline points={svgData.pts} fill="none" stroke={tyreColor} strokeWidth="1.5" strokeOpacity="0.7" />
                            <circle cx={svgData.dotX} cy={svgData.dotY} r="2.5" fill={tyreColor} />
                            <circle cx={svgData.dotX} cy={svgData.dotY} r="4.5" fill="none" stroke={tyreColor} strokeWidth="1" strokeOpacity="0.35" />
                          </svg>
                        </div>
                      )
                    })()}

                    {/* All-driver wear table */}
                    <div className="flex-1 overflow-y-auto">
                      {/* Column headers */}
                      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-border-dark sticky top-0 bg-bg-primary">
                        <span className="font-mono text-[8px] text-text-dim w-5 text-right">P</span>
                        <span className="font-mono text-[8px] text-text-dim w-7">DRV</span>
                        <span className="font-mono text-[8px] text-text-dim w-4" />
                        <span className="font-mono text-[8px] text-text-dim flex-1">WEAR</span>
                        <span className="font-mono text-[8px] text-text-dim w-12 text-right">GRIP EST</span>
                        <span className="font-mono text-[8px] text-text-dim w-8 text-right">LAPS</span>
                      </div>

                      {[...timing]
                        .sort((a, b) => a.position - b.position)
                        .map(row => {
                          const wear = tyreWearPct(row.compound, row.tyreAge)
                          const grip = Math.max(0, 100 - wear)
                          const barColor = wearColor(wear)
                          const tc = TYRE_COLOR[row.compound] ?? '#888'
                          const isSelected = row.code === selectedCode
                          const isCritical = wear >= 85

                          return (
                            <div
                              key={row.code}
                              className={`flex items-center gap-1.5 px-3 py-[3px] ${isSelected ? 'bg-bg-secondary' : ''}`}
                            >
                              {/* Position */}
                              <span className="font-mono text-[9px] text-text-dim w-5 text-right shrink-0">
                                {row.position}
                              </span>

                              {/* Driver code */}
                              <span
                                className="font-display text-[10px] font-bold w-7 shrink-0"
                                style={{ color: isSelected ? '#fff' : 'rgba(220,220,220,0.75)' }}
                              >
                                {row.code}
                              </span>

                              {/* Compound dot */}
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ background: tc }}
                                title={row.compound}
                              />

                              {/* Wear bar (compound-normalised) */}
                              <div className="flex-1 h-1 bg-border-dark rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all duration-500"
                                  style={{ width: `${wear}%`, background: barColor }}
                                />
                              </div>

                              {/* Grip estimate */}
                              <span
                                className="font-mono text-[9px] w-12 text-right shrink-0 tabular-nums"
                                style={{ color: isCritical ? '#e8002d' : grip > 55 ? '#00c853' : '#ffd600' }}
                              >
                                {isCritical ? '⚠ ' : ''}{grip.toFixed(0)}%
                              </span>

                              {/* Tyre age */}
                              <span className="font-mono text-[9px] text-text-dim w-8 text-right shrink-0 tabular-nums">
                                {row.tyreAge}L
                              </span>
                            </div>
                          )
                        })}
                    </div>

                    {/* Legend */}
                    <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-dark shrink-0">
                      {(['SOFT', 'MEDIUM', 'HARD'] as TyreCompound[]).map(c => (
                        <div key={c} className="flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: TYRE_COLOR[c] }} />
                          <span className="font-mono text-[8px] text-text-dim">
                            {c[0]}{c.slice(1,3).toLowerCase()} ~{COMPOUND_LIFE[c]}L
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </DashCard>

              {/* ERS Estimate (selected driver) */}
              <DashCard title="ERS Estimate" tag="INFERRED" accent="#00bcd4" className="flex-1 min-h-[120px] md:min-h-0">
                {isLiveSession ? (
                  <div className="flex items-center justify-center flex-1">
                    <span className="font-mono text-[10px] text-text-dim text-center px-3">Available in archive replay</span>
                  </div>
                ) : selectedErs ? (
                  <div className="p-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-text-dim">Deploy</span>
                      <span className="font-mono text-xs text-text-primary">{selectedErs.deploymentPercent.toFixed(1)}%</span>
                    </div>
                    <div className="h-1 bg-border-dark rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-cyan-400" style={{ width: `${selectedErs.deploymentPercent}%` }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-text-dim">Harvest</span>
                      <span className="font-mono text-xs text-text-primary">{selectedErs.harvestPercent.toFixed(1)}%</span>
                    </div>
                    <div className="h-1 bg-border-dark rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-emerald-400" style={{ width: `${selectedErs.harvestPercent}%` }} />
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center flex-1">
                    <span className="font-mono text-xs text-text-dim">Awaiting data…</span>
                  </div>
                )}
              </DashCard>

              {/* Weather */}
              <DashCard title="Weather" accent="#358c75" className="flex-1 min-h-[160px] md:min-h-0">
                {!weather ? (
                  <div className="flex items-center justify-center flex-1 h-full">
                    <span className="font-mono text-xs text-text-dim">Awaiting data…</span>
                  </div>
                ) : (() => {
                  const trackTemp = weather.trackTemperature
                  const airTemp   = weather.airTemperature
                  const tempDelta = trackTemp - airTemp
                  const isWet     = weather.rainfall >= 0.5
                  const isDamp    = !isWet && weather.rainfall > 0
                  const condLabel = isWet ? 'WET' : isDamp ? 'DAMP' : 'DRY'
                  const condColor = isWet ? '#0093cc' : isDamp ? '#ffd600' : '#00c853'

                  // Wind: FastF1 gives direction wind is FROM. Arrow points where it's going.
                  const windDeg = weather.windDirection
                  const arrowDeg = (windDeg + 180) % 360
                  const arrowRad = (arrowDeg - 90) * (Math.PI / 180)
                  const ax = 12 + Math.cos(arrowRad) * 8
                  const ay = 12 + Math.sin(arrowRad) * 8
                  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
                  const cardinal = dirs[Math.round(windDeg / 22.5) % 16]

                  // Derived values
                  // Dew point approximation: Magnus formula simplified
                  const dewPoint = airTemp - ((100 - weather.humidity) / 5)
                  // Tyre stress: based on track temp + delta
                  const tyreStress = trackTemp > 52 ? 'HIGH' : trackTemp > 42 ? 'MOD' : trackTemp > 30 ? 'LOW' : 'COLD'
                  const tyreStressColor = tyreStress === 'HIGH' ? '#e8002d' : tyreStress === 'MOD' ? '#ff8000' : tyreStress === 'LOW' ? '#00c853' : '#0093cc'
                  // Track temp gradient bar: 0–70°C range
                  const markerPct = Math.min(100, Math.max(0, (trackTemp / 68) * 100))
                  const isHighWind = weather.windSpeed >= 20

                  return (
                    <div className="px-3 pt-2 pb-2 flex flex-col gap-2 h-full">

                      {/* Row 1: condition badge + tyre stress */}
                      <div className="flex items-center justify-between shrink-0">
                        <span
                          className="font-mono text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-full"
                          style={{ background: `${condColor}22`, color: condColor, border: `1px solid ${condColor}55` }}
                        >
                          {condLabel}{(isWet || isDamp) ? ` · ${weather.rainfall.toFixed(1)}mm/h` : ''}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Tyre Stress</span>
                          <span className="font-mono text-[9px] font-bold" style={{ color: tyreStressColor }}>{tyreStress}</span>
                        </div>
                      </div>

                      {/* Row 2: temperatures + delta */}
                      <div className="flex items-end gap-3 shrink-0">
                        <div className="flex flex-col">
                          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Track</span>
                          <span className="font-display text-lg font-black text-text-primary leading-none">
                            {trackTemp.toFixed(1)}°
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Air</span>
                          <span className="font-display text-sm font-bold text-text-muted leading-none">
                            {airTemp.toFixed(1)}°
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Dew Pt</span>
                          <span className="font-mono text-xs text-text-muted leading-none">
                            {dewPoint.toFixed(1)}°
                          </span>
                        </div>
                        <div className="ml-auto flex flex-col items-end">
                          <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Δ Track−Air</span>
                          <span
                            className="font-mono text-xs font-bold leading-none"
                            style={{ color: tempDelta > 15 ? '#ff8000' : tempDelta > 8 ? '#ffd600' : '#00c853' }}
                          >
                            +{tempDelta.toFixed(1)}°
                          </span>
                        </div>
                      </div>

                      {/* Row 3: track temp gradient bar */}
                      <div className="shrink-0">
                        <div className="relative h-1.5 rounded-full overflow-visible" style={{
                          background: 'linear-gradient(to right, #0093cc 0%, #00c853 30%, #ffd600 55%, #ff8000 75%, #e8002d 100%)'
                        }}>
                          {/* Marker */}
                          <div
                            className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white border border-bg-primary"
                            style={{ left: `calc(${markerPct}% - 4px)` }}
                          />
                        </div>
                        <div className="flex justify-between mt-0.5">
                          <span className="font-mono text-[8px] text-text-dim">COLD</span>
                          <span className="font-mono text-[8px] text-text-dim">OPTIMAL</span>
                          <span className="font-mono text-[8px] text-text-dim">HOT</span>
                        </div>
                      </div>

                      {/* Row 4: wind + humidity */}
                      <div className="flex items-center gap-2 shrink-0">
                        {/* Mini compass */}
                        <svg width="24" height="24" viewBox="0 0 24 24" className="shrink-0">
                          <circle cx="12" cy="12" r="11" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
                          <text x="12" y="5.5" fontSize="4" fill="rgba(255,255,255,0.3)" textAnchor="middle" fontFamily="monospace">N</text>
                          <text x="12" y="21" fontSize="4" fill="rgba(255,255,255,0.2)" textAnchor="middle" fontFamily="monospace">S</text>
                          <text x="4" y="13.5" fontSize="4" fill="rgba(255,255,255,0.2)" textAnchor="middle" fontFamily="monospace">W</text>
                          <text x="20.5" y="13.5" fontSize="4" fill="rgba(255,255,255,0.2)" textAnchor="middle" fontFamily="monospace">E</text>
                          <line x1="12" y1="12" x2={ax.toFixed(1)} y2={ay.toFixed(1)} stroke="#00c853" strokeWidth="1.5" strokeLinecap="round" />
                          <circle cx={ax.toFixed(1)} cy={ay.toFixed(1)} r="1.5" fill="#00c853" />
                          <circle cx="12" cy="12" r="1.5" fill="rgba(255,255,255,0.4)" />
                        </svg>
                        <div className="flex flex-col">
                          <span className="font-mono text-[8px] text-text-dim uppercase">{cardinal}</span>
                          <div className="flex items-baseline gap-1">
                            <span className="font-mono text-xs text-text-primary">{weather.windSpeed.toFixed(1)}</span>
                            <span className="font-mono text-[9px] text-text-dim">km/h</span>
                            {isHighWind && (
                              <span className="font-mono text-[8px] font-bold ml-1" style={{ color: '#ffd600' }}>GUSTY</span>
                            )}
                          </div>
                        </div>

                        {/* Humidity + dew point spread */}
                        <div className="ml-auto flex flex-col items-end gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[8px] text-text-dim uppercase tracking-widest">Humidity</span>
                            <span className="font-mono text-[9px] text-text-muted tabular-nums">{Math.round(weather.humidity)}%</span>
                          </div>
                          <div className="w-24 h-1 bg-border-dark rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${weather.humidity}%`,
                                background: weather.humidity > 80 ? '#0093cc' : weather.humidity > 60 ? '#358c75' : '#555',
                              }}
                            />
                          </div>
                        </div>
                      </div>

                    </div>
                  )
                })()}
              </DashCard>
            </div>
          </div>

          {/* Bottom row — 3 cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 border-t border-border-dark md:shrink-0 [&>*]:min-h-[160px] md:[&>*]:min-h-0 md:h-[180px]">

            {/* Telemetry — selected driver */}
            <DashCard
              title="Telemetry"
              tag={selectedRow ? `${selectedRow.code} · SPD·THR·BRK` : 'SPD·THR·BRK'}
              accent="#e8002d"
              className="h-full border-b md:border-b-0 border-r border-border-dark"
            >
              {selectedTel ? (
                <div className="flex flex-col justify-center h-full px-4 gap-3">
                  {[
                    { label: 'SPD', value: selectedTel.speed, max: 350, color: selectedRow ? `#${selectedRow.teamColour}` : '#e8002d', suffix: ' km/h' },
                    { label: 'THR', value: selectedTel.throttle, max: 100, color: '#00c853', suffix: '%' },
                    { label: 'BRK', value: selectedTel.brake, max: 100, color: '#e8002d', suffix: '%' },
                    { label: 'RPM', value: selectedTel.rpm, max: 15000, color: '#ffd600', suffix: '' },
                  ].map(({ label, value, max, color, suffix }) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-text-dim w-7 shrink-0">{label}</span>
                      <div className="flex-1 h-1.5 bg-border-dark rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }}
                        />
                      </div>
                      <span className="font-mono text-[10px] text-text-dim w-14 text-right">
                        {label === 'RPM' ? Math.round(value).toLocaleString() : value.toFixed(0)}{suffix}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center gap-3 pt-1 border-t border-border-dark">
                    <span className="font-mono text-[10px] text-text-dim">Gear</span>
                    <span className="font-display text-sm font-black text-text-primary">{selectedTel.gear}</span>
                    <span className="font-mono text-[10px] text-text-dim ml-4">DRS</span>
                    <span className="font-mono text-[10px]" style={{ color: selectedTel.drs > 8 ? '#00c853' : '#555' }}>
                      {selectedTel.drs > 8 ? 'OPEN' : 'CLOSED'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 gap-1">
                  {wsReady && hasTelemetry === false ? (
                    <>
                      <span className="font-mono text-xs text-text-dim">Telemetry unavailable</span>
                      <span className="font-mono text-[10px] text-text-dim opacity-60">(locked by F1 since Aug 2025)</span>
                    </>
                  ) : (
                    <span className="font-mono text-xs text-text-dim">Awaiting telemetry</span>
                  )}
                </div>
              )}
            </DashCard>

            {/* Race Control / Track Status */}
            <DashCard title="Race Control" tag="FLAGS · MESSAGES" accent="#ff8000" className="h-full border-b md:border-b-0 border-r border-border-dark">
              <RaceControl messages={raceControl} trackStatus={trackStatus} />
            </DashCard>

            {/* Sector Delta */}
            <DashCard title="Sector Delta" tag={selectedRow ? `${selectedRow.code} · S1·S2·S3` : 'S1·S2·S3'} accent="#00c853" className="h-full">
              {isLiveSession ? (
                <div className="flex items-center justify-center flex-1 h-full">
                  <span className="font-mono text-[10px] text-text-dim text-center px-3">Available in archive replay</span>
                </div>
              ) : !bestSectors && !selectedRow ? (
                <div className="flex items-center justify-center flex-1 h-full">
                  <span className="font-mono text-xs text-text-dim">Awaiting data…</span>
                </div>
              ) : (() => {
                const drvSectors = selectedCode ? lastSectors[selectedCode] : undefined
                const drvColor = selectedRow ? `#${selectedRow.teamColour}` : '#888'

                // Format seconds → "1:18.345" or "28.345"
                function fmtS(s: number | null | undefined): string {
                  if (s == null) return '—'
                  if (s >= 60) {
                    const m = Math.floor(s / 60)
                    return `${m}:${(s % 60).toFixed(3).padStart(6, '0')}`
                  }
                  return s.toFixed(3)
                }
                function fmtDelta(driver: number | null | undefined, best: number | null | undefined): string {
                  if (driver == null || best == null) return ''
                  const d = driver - best
                  return d === 0 ? '±0.000' : `${d > 0 ? '+' : ''}${d.toFixed(3)}`
                }

                const sectors = [
                  { key: 's1' as const, label: 'S1' },
                  { key: 's2' as const, label: 'S2' },
                  { key: 's3' as const, label: 'S3' },
                ]

                return (
                  <div className="px-3 py-2 flex flex-col gap-1.5 overflow-hidden">

                    {/* Column headers: S1 · S2 · S3 + lap label */}
                    <div className="grid grid-cols-3 gap-2">
                      {sectors.map(({ key, label }) => (
                        <div key={key} className="flex items-center gap-1.5">
                          <div className="w-0.5 h-3 rounded-full shrink-0" style={{ background: key === 's1' ? '#c8d4e4' : key === 's2' ? '#ffd600' : '#e8002d' }} />
                          <span className="font-mono text-[9px] tracking-widest" style={{ color: key === 's1' ? '#c8d4e4' : key === 's2' ? '#ffd600' : '#e8002d' }}>{label}</span>
                        </div>
                      ))}
                    </div>

                    {/* Driver lap row */}
                    <div className="grid grid-cols-3 gap-2">
                      {sectors.map(({ key }) => {
                        const sTime = drvSectors?.[key]
                        const bestTime = bestSectors?.[key]?.time
                        const isBest = sTime != null && bestTime != null && Math.abs(sTime - bestTime) < 0.001
                        const delta = sTime != null && bestTime != null ? sTime - bestTime : null
                        const timeColor = isBest ? '#b36bff' : delta == null ? '#aaa' : delta <= 0.1 ? '#00c853' : delta <= 0.5 ? '#ffd600' : '#e8002d'
                        return (
                          <div key={key} className="flex flex-col gap-px">
                            <span className="font-mono text-[11px] font-bold tabular-nums leading-tight" style={{ color: timeColor }}>
                              {fmtS(sTime)}
                            </span>
                            <span className="font-mono text-[9px] tabular-nums leading-tight" style={{ color: timeColor }}>
                              {isBest ? '● best' : fmtDelta(sTime, bestTime) || '—'}
                            </span>
                          </div>
                        )
                      })}
                    </div>

                    {/* Driver label + lap sum */}
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: drvColor }}>
                        {selectedRow?.code ?? '—'}{drvSectors?.lap != null ? ` · L${drvSectors.lap}` : ''}
                      </span>
                      {drvSectors?.s1 != null && drvSectors.s2 != null && drvSectors.s3 != null && (
                        <span className="font-mono text-[9px] font-bold text-text-primary tabular-nums">
                          Σ {fmtS(drvSectors.s1 + drvSectors.s2 + drvSectors.s3)}
                        </span>
                      )}
                    </div>

                    {/* Separator */}
                    <div className="h-px bg-border-dark" />

                    {/* Session best row */}
                    <div className="grid grid-cols-3 gap-2">
                      {sectors.map(({ key }) => {
                        const best = bestSectors?.[key]
                        const tc = best ? timing.find(r => r.code === best.driver)?.teamColour : undefined
                        const teamColor = tc ? `#${tc}` : '#b36bff'
                        return (
                          <div key={key} className="flex flex-col gap-px">
                            <span className="font-mono text-[11px] font-bold tabular-nums leading-tight" style={{ color: '#b36bff' }}>
                              {fmtS(best?.time)}
                            </span>
                            <span className="font-display text-[9px] font-bold leading-tight" style={{ color: teamColor }}>
                              {best?.driver ?? '—'}
                            </span>
                          </div>
                        )
                      })}
                    </div>

                    {/* Session best label */}
                    <span className="font-mono text-[8px] tracking-widest uppercase" style={{ color: '#b36bff' }}>Session Best</span>

                  </div>
                )
              })()}
            </DashCard>
          </div>
        </div>
      )}

      {showDriverPicker && activeSession && (
        <DriverPicker
          excludeDriver={activeSession.driverA}
          onConfirm={(driverB) => {
            setShowDriverPicker(false)
            router.push(
              `/dashboard/compare?year=${activeSession.year}&gp=${encodeURIComponent(activeSession.gp)}&session=${encodeURIComponent(activeSession.sessionType)}&driverA=${activeSession.driverA ?? 'VER'}&driverB=${driverB}`
            )
          }}
          onClose={() => setShowDriverPicker(false)}
        />
      )}
    </>
  )
}

export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center flex-1">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border border-text-dim border-t-f1-red rounded-full animate-spin" />
          <span className="font-mono text-xs text-text-dim tracking-widest uppercase">Loading</span>
        </div>
      </div>
    }>
      <DashboardContent />
    </Suspense>
  )
}
