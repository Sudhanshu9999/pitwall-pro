'use client'

import { TimingRow, TyreCompound } from '@/types'
import { useDashboardStore } from '@/store/dashboardStore'

interface TimingTowerProps {
  rows: TimingRow[]
}

const TYRE_COLORS: Record<TyreCompound, string> = {
  SOFT: '#e8002d',
  MEDIUM: '#ffd600',
  HARD: '#f0f0f0',
  INTERMEDIATE: '#00c853',
  WET: '#0093cc',
}

const TYRE_ABBR: Record<TyreCompound, string> = {
  SOFT: 'S',
  MEDIUM: 'M',
  HARD: 'H',
  INTERMEDIATE: 'I',
  WET: 'W',
}

function formatLapTime(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  const sInt = Math.floor(s)
  const ms = Math.round((s - sInt) * 1000)
  return `${m}:${String(sInt).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** True for sessions where best lap is the primary ranking metric. */
function isPracticeLike(sessionType: string): boolean {
  const t = sessionType.toLowerCase()
  return t.includes('practice') || t.includes('qualifying')
}

export default function TimingTower({ rows }: TimingTowerProps) {
  const sessionType = useDashboardStore((s) => s.sessionType)
  const activeSessionType = useDashboardStore((s) => s.activeSession?.sessionType ?? '')
  const effectiveType = sessionType || String(activeSessionType)
  const practiceMode = isPracticeLike(effectiveType)

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="font-mono text-xs text-text-dim">Awaiting timing data…</span>
      </div>
    )
  }

  // Practice / Qualifying: POS | DRV | BEST | GAP | INT | TYR | AGE | ●
  // Race / Sprint:         POS | DRV | GAP  | INT | TYR | AGE | ●
  const headers = practiceMode
    ? ['POS', 'DRV', 'BEST', 'GAP', 'INT', 'TYR', 'AGE', '']
    : ['POS', 'DRV', 'GAP', 'INT', 'TYR', 'AGE', '']

  const gridCols = practiceMode ? 'grid-cols-8' : 'grid-cols-7'

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Column headers */}
      <div className={`grid ${gridCols} gap-1 px-3 py-1.5 border-b border-border-dark shrink-0`}>
        {headers.map((h, i) => (
          <span key={i} className="font-mono text-xs text-text-dim text-center">{h}</span>
        ))}
      </div>

      {/* Rows — scrollable */}
      <div className="flex flex-col divide-y divide-border-dark overflow-y-auto flex-1 min-h-0">
        {rows.map(d => (
          <div
            key={`${d.driverNumber}-${d.code}`}
            className={`grid ${gridCols} gap-1 items-center px-3 py-2 hover:bg-bg-card-hover transition-colors`}
          >
            {/* POS */}
            <span className="font-mono text-xs text-text-muted text-center">{d.position}</span>

            {/* DRV */}
            <span
              className="font-display text-xs font-bold text-center"
              style={{ color: d.teamColour ? `#${d.teamColour.replace('#', '')}` : undefined }}
            >
              {d.code}
            </span>

            {/* BEST — only in practice/qualifying */}
            {practiceMode && (
              <span className="font-mono text-xs text-text-primary text-center tabular-nums">
                {formatLapTime(d.bestLap)}
              </span>
            )}

            {/* GAP */}
            <span className={`font-mono text-xs text-center tabular-nums ${d.position === 1 ? 'text-flag-green' : 'text-text-primary'}`}>
              {d.gap}
            </span>

            {/* INT */}
            <span className={`font-mono text-xs text-center tabular-nums ${d.position === 1 ? 'text-flag-green' : 'text-text-muted'}`}>
              {d.interval}
            </span>

            {/* TYR */}
            <div className="flex items-center justify-center gap-1">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: TYRE_COLORS[d.compound] ?? '#555' }}
              />
              <span className="font-mono text-xs text-text-muted">{TYRE_ABBR[d.compound] ?? d.compound[0]}</span>
            </div>

            {/* AGE */}
            <span className="font-mono text-xs text-text-dim text-center">{d.tyreAge}</span>

            {/* Status dot */}
            <span
              className={`w-2 h-2 rounded-full mx-auto ${
                d.status === 'out'
                  ? 'bg-f1-red'
                  : d.status === 'pit'
                  ? 'bg-safety-car'
                  : 'bg-flag-green'
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
