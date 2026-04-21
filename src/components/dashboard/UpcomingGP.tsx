'use client'

import { useEffect, useState, useMemo } from 'react'
import { fetchSchedule, ApiScheduleEvent, ApiScheduleSession } from '@/lib/api'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDay(date: Date) {
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

function formatTime(date: Date) {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m} local`
}

function pad(n: number) { return String(n).padStart(2, '0') }

export default function UpcomingGP() {
  const [nextEvent, setNextEvent] = useState<ApiScheduleEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [timeLeft, setTimeLeft] = useState({ d: 0, h: 0, m: 0, s: 0 })

  useEffect(() => {
    fetchSchedule()
      .then((res) => setNextEvent(res.next_event))
      .catch(() => setNextEvent(null))
      .finally(() => setLoading(false))
  }, [])

  // Countdown — recompute every second against the Race session start
  useEffect(() => {
    if (!nextEvent) return
    const nowMs = Date.now()
    const raceSessions = nextEvent.sessions.filter(
      (s: ApiScheduleSession) =>
        s.session_type === 'Race' &&
        (!s.is_past || (s.date_end ? new Date(s.date_end).getTime() > nowMs : false)),
    )
    const targetIso = raceSessions[0]?.date_start ?? nextEvent.date_end
    const targetMs = new Date(targetIso).getTime()

    const calc = () => {
      const diff = targetMs - Date.now()
      if (diff <= 0) { setTimeLeft({ d: 0, h: 0, m: 0, s: 0 }); return }
      setTimeLeft({
        d: Math.floor(diff / 86400000),
        h: Math.floor((diff % 86400000) / 3600000),
        m: Math.floor((diff % 3600000) / 60000),
        s: Math.floor((diff % 60000) / 1000),
      })
    }
    calc()
    const id = setInterval(calc, 1000)
    return () => clearInterval(id)
  }, [nextEvent])

  // Memoized so countdown interval ticks (setTimeLeft every 1s) don't
  // re-run this on every second. Must be before early returns (Rules of Hooks).
  //
  // Two-layer filter for robustness:
  //   1. Server-computed is_past=false (primary — most reliable)
  //   2. Client-side date_end > now (fallback — handles FastF1 fallback path,
  //      clock-skew, or stale is_past flags)
  // Sessions with no date_end default to showing (is_past=false on the server).
  const displaySessions = useMemo(() => {
    if (!nextEvent) return []
    const nowMs = Date.now()
    return nextEvent.sessions.filter((s: ApiScheduleSession) => {
      if (!s.is_past) return true
      return s.date_end ? new Date(s.date_end).getTime() > nowMs : false
    })
  }, [nextEvent])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="font-mono text-xs text-text-dim tracking-widest uppercase">Loading schedule…</span>
      </div>
    )
  }

  if (!nextEvent) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="font-mono text-xs text-text-dim">No upcoming events</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col lg:flex-row h-full gap-px">
      {/* Left — Countdown */}
      <div className="flex-1 flex flex-col items-start justify-center p-4 sm:p-6 lg:p-10 relative overflow-hidden">
        <span className="absolute bottom-4 right-6 font-display text-8xl font-black text-text-primary opacity-[0.03] select-none uppercase">
          {nextEvent.country_code}
        </span>
        <span className="font-mono text-xs text-f1-red tracking-widest uppercase mb-3 sm:mb-4">
          Next Grand Prix
        </span>
        <h2 className="font-display text-xl sm:text-3xl lg:text-4xl font-black text-text-primary uppercase tracking-wide leading-tight mb-6 sm:mb-10">
          {nextEvent.name}
        </h2>

        <div className="flex items-end gap-2 sm:gap-3">
          {[{ val: timeLeft.d, label: 'Days' }, { val: timeLeft.h, label: 'Hours' }, { val: timeLeft.m, label: 'Min' }, { val: timeLeft.s, label: 'Sec' }].map(({ val, label }, i) => (
            <div key={label} className="flex items-end gap-1">
              {i > 0 && <span className="font-display text-xl sm:text-3xl text-text-dim mb-2 sm:mb-3">:</span>}
              <div className="flex flex-col items-center">
                <span className="font-display text-3xl sm:text-4xl lg:text-5xl font-black text-f1-red tabular-nums">{pad(val)}</span>
                <span className="font-mono text-[10px] sm:text-xs text-text-dim mt-1 tracking-widest uppercase">{label}</span>
              </div>
            </div>
          ))}
        </div>

        <p className="font-mono text-xs text-text-dim mt-4 sm:mt-6">{nextEvent.circuit} · {nextEvent.location}</p>
      </div>

      {/* Right — Schedule */}
      <div className="w-full lg:w-72 border-t lg:border-t-0 lg:border-l border-border-dark flex flex-col">
        <div className="px-4 py-3 border-b border-border-dark shrink-0">
          <span className="font-display text-xs font-semibold text-text-primary tracking-widest uppercase">Session Schedule</span>
          <p className="font-mono text-xs text-text-dim mt-0.5">Your local timezone</p>
        </div>
        <div className="flex flex-col divide-y divide-border-dark flex-1 overflow-y-auto">
          {displaySessions.length === 0 ? (
            <div className="flex items-center justify-center flex-1 p-4">
              <span className="font-mono text-xs text-text-dim">No upcoming sessions</span>
            </div>
          ) : (
            displaySessions.map((s: ApiScheduleSession) => {
              const isRace = s.session_type === 'Race'
              const date = new Date(s.date_start)
              return (
                <div key={s.session_key ?? s.session_name} className={`flex flex-col px-4 py-3 ${isRace ? 'bg-bg-card-hover' : ''}`}>
                  <div className="flex items-center justify-between">
                    <span className={`font-display text-xs font-semibold tracking-wider uppercase ${isRace ? 'text-f1-red' : 'text-text-primary'}`}>
                      {s.session_name}
                    </span>
                    {isRace && !s.is_live && (
                      <span className="font-mono text-xs text-f1-red border border-f1-red px-1.5 py-0.5">RACE</span>
                    )}
                    {s.is_live && (
                      <span className="font-mono text-xs text-flag-green border border-flag-green px-1.5 py-0.5">LIVE</span>
                    )}
                  </div>
                  <span className="font-mono text-xs text-text-dim">{formatDay(date)}</span>
                  <span className="font-mono text-xs text-text-muted">{formatTime(date)}</span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
