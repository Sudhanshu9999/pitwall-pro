'use client'

import { useState, useEffect, useRef } from 'react'
import { SessionType } from '@/types'
import {
  fetchEvents,
  fetchSessions,
  fetchDrivers,
  loadSession,
  ApiEventInfo,
  ApiSessionInfo,
  ApiDriverInfo,
} from '@/lib/api'

interface SessionSelectorProps {
  onConfirm: (params: { year: number; gp: string; sessionType: SessionType; driverA?: string; driverB?: string }) => void
  onClose?: () => void
}

const CURRENT_YEAR = new Date().getFullYear()
const AVAILABLE_YEARS = Array.from(
  { length: CURRENT_YEAR - 2018 + 1 },
  (_, i) => CURRENT_YEAR - i,
)

export default function SessionSelector({ onConfirm, onClose }: SessionSelectorProps) {
  const [year, setYear] = useState(CURRENT_YEAR)
  const [gp, setGp] = useState('')
  const [sessionType, setSessionType] = useState<SessionType>('Race')
  const [driverA, setDriverA] = useState('')
  const [driverB, setDriverB] = useState('')
  const [compareMode, setCompareMode] = useState(false)

  const [events, setEvents] = useState<ApiEventInfo[]>([])
  const [sessions, setSessions] = useState<ApiSessionInfo[]>([])
  const [drivers, setDrivers] = useState<ApiDriverInfo[]>([])

  const [loadingEvents, setLoadingEvents] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingDrivers, setLoadingDrivers] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // When GP was just changed the sessions effect auto-sets sessionType,
  // which would re-trigger the drivers effect. This ref skips that spurious call.
  const skipNextDriversFetch = useRef(false)

  // Fetch events whenever year changes
  useEffect(() => {
    let cancelled = false
    setLoadingEvents(true)
    setGp('')
    setSessions([])
    setDrivers([])
    fetchEvents(year)
      .then((res) => { if (!cancelled) setEvents(res.events) })
      .catch(() => { if (!cancelled) setEvents([]) })
      .finally(() => { if (!cancelled) setLoadingEvents(false) })
    return () => { cancelled = true }
  }, [year])

  // Fetch sessions + drivers together whenever GP changes
  useEffect(() => {
    if (!gp) { setSessions([]); setDrivers([]); return }
    let cancelled = false
    setLoadingSessions(true)
    setDrivers([])
    fetchSessions(year, gp)
      .then(async (res) => {
        if (cancelled) return
        setSessions(res.sessions)
        if (res.sessions.length > 0) {
          const firstType = res.sessions[0].session_type as SessionType
          // Mark so the drivers effect below skips this auto-set
          skipNextDriversFetch.current = true
          setSessionType(firstType)
          setLoadingDrivers(true)
          try {
            const drvRes = await fetchDrivers(year, gp, firstType)
            if (!cancelled) setDrivers(drvRes.drivers)
          } catch {
            if (!cancelled) setDrivers([])
          } finally {
            if (!cancelled) setLoadingDrivers(false)
          }
        }
      })
      .catch(() => { if (!cancelled) setSessions([]) })
      .finally(() => { if (!cancelled) setLoadingSessions(false) })
    return () => { cancelled = true }
  }, [year, gp])

  // Fetch drivers when user explicitly picks a different session type
  useEffect(() => {
    if (skipNextDriversFetch.current) {
      skipNextDriversFetch.current = false
      return
    }
    if (!gp || !sessionType) { setDrivers([]); return }
    let cancelled = false
    setLoadingDrivers(true)
    fetchDrivers(year, gp, sessionType)
      .then((res) => { if (!cancelled) setDrivers(res.drivers) })
      .catch(() => { if (!cancelled) setDrivers([]) })
      .finally(() => { if (!cancelled) setLoadingDrivers(false) })
    return () => { cancelled = true }
  }, [year, gp, sessionType])

  const handleLoad = async () => {
    if (!gp) return
    setLoadingSession(true)
    setLoadError(null)
    try {
      await loadSession(year, gp, sessionType)
      onConfirm({ year, gp, sessionType, driverA: driverA || undefined, driverB: driverB || undefined })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load session')
    } finally {
      setLoadingSession(false)
    }
  }

  const availableSessionTypes = sessions.map((s) => s.session_type as SessionType)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-primary p-4" style={{ backgroundColor: 'rgba(8,8,8,0.97)' }}>
      <div className="w-full max-w-xl border border-border-dark bg-bg-secondary relative">
        <div className="h-px w-full bg-f1-red" />

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-dark">
          <div>
            <span className="font-mono text-xs text-f1-red tracking-widest uppercase">Archive Mode</span>
            <h3 className="font-display text-sm font-bold text-text-primary tracking-wider uppercase mt-0.5">Select Session</h3>
          </div>
          {onClose && (
            <button onClick={onClose} className="text-text-dim hover:text-text-muted transition-colors p-1">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Form */}
        <div className="p-6 flex flex-col gap-5">
          {/* Year + GP */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <label className="font-mono text-xs text-text-dim tracking-widest uppercase">Season</label>
              <select
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                className="w-full bg-bg-card border border-border-dark px-3 py-2.5 font-mono text-xs text-text-primary focus:outline-none focus:border-f1-red transition-colors"
              >
                {AVAILABLE_YEARS.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="font-mono text-xs text-text-dim tracking-widest uppercase">Grand Prix</label>
              <select
                value={gp}
                onChange={e => setGp(e.target.value)}
                disabled={loadingEvents}
                className="w-full bg-bg-card border border-border-dark px-3 py-2.5 font-mono text-xs text-text-primary focus:outline-none focus:border-f1-red transition-colors disabled:opacity-50"
              >
                <option value="">{loadingEvents ? 'Loading…' : 'Select GP…'}</option>
                {events.map(e => <option key={e.name} value={e.name}>{e.name}</option>)}
              </select>
            </div>
          </div>

          {/* Session type */}
          <div className="flex flex-col gap-2">
            <label className="font-mono text-xs text-text-dim tracking-widest uppercase">Session Type</label>
            {loadingSessions ? (
              <div className="h-8 flex items-center">
                <span className="font-mono text-xs text-text-dim">Loading sessions…</span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableSessionTypes.length > 0
                  ? availableSessionTypes.map(s => (
                    <button
                      key={s}
                      onClick={() => setSessionType(s)}
                      className={`px-3 py-1.5 font-display text-xs font-semibold tracking-wider uppercase border transition-colors ${
                        sessionType === s ? 'bg-f1-red border-f1-red text-white' : 'border-border-dark text-text-dim hover:border-border-accent'
                      }`}
                    >
                      {s}
                    </button>
                  ))
                  : <span className="font-mono text-xs text-text-dim">Select a GP first</span>
                }
              </div>
            )}
          </div>

          {/* Driver filter */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="font-mono text-xs text-text-dim tracking-widest uppercase">Driver Filter</label>
              <button
                onClick={() => setCompareMode(!compareMode)}
                className="flex items-center gap-2 font-mono text-xs text-text-dim hover:text-text-muted transition-colors"
              >
                <span className={`w-7 h-3.5 rounded-full relative transition-colors ${compareMode ? 'bg-f1-red' : 'bg-border-accent'}`}>
                  <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${compareMode ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </span>
                Compare mode
              </button>
            </div>
            {loadingDrivers ? (
              <div className="h-8 flex items-center">
                <span className="font-mono text-xs text-text-dim">Loading drivers…</span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {drivers.length > 0
                  ? drivers.map(d => (
                    <button
                      key={d.code}
                      onClick={() => {
                        if (!compareMode) {
                          setDriverA(driverA === d.code ? '' : d.code)
                        } else {
                          if (driverA === d.code) setDriverA('')
                          else if (driverB === d.code) setDriverB('')
                          else if (!driverA) setDriverA(d.code)
                          else if (!driverB) setDriverB(d.code)
                          else setDriverA(d.code)
                        }
                      }}
                      className={`px-2 py-1 font-mono text-xs border transition-colors ${
                        driverA === d.code ? 'border-f1-red text-f1-red bg-f1-red-muted'
                        : driverB === d.code ? 'border-safety-car text-safety-car'
                        : 'border-border-dark text-text-dim hover:border-border-accent'
                      }`}
                    >
                      {d.code}
                    </button>
                  ))
                  : <span className="font-mono text-xs text-text-dim">{gp ? 'Select a session type' : 'Select a GP first'}</span>
                }
              </div>
            )}
          </div>

          {loadError && (
            <p className="font-mono text-xs text-f1-red">{loadError}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 px-6 py-4 border-t border-border-dark">
          {loadingSession && (
            <p className="font-mono text-[10px] text-text-dim">
              First load downloads data from FastF1 — this can take 1–2 min. Subsequent loads are instant.
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-text-dim">
              {!gp ? 'Select a GP to continue' : !driverA ? 'Select a driver to continue' : `${year} ${gp} — ${sessionType}`}
            </span>
            <button
              disabled={!gp || !driverA || loadingSession}
              onClick={handleLoad}
              className={`px-6 py-2.5 font-display text-xs font-bold tracking-widest uppercase transition-colors ${
                gp && !loadingSession ? 'bg-f1-red text-white hover:bg-f1-red-bright' : 'bg-border-dark text-text-dim cursor-not-allowed'
              }`}
            >
              {loadingSession ? 'Loading…' : 'Load Session →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
