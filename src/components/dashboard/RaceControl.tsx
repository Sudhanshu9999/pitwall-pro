'use client'

import { RaceControlMessage } from '@/types'

interface RaceControlProps {
  messages: RaceControlMessage[]
  trackStatus: { status: string; message: string } | null
}

const FLAG_COLOR: Record<string, string> = {
  GREEN: '#00c853',
  YELLOW: '#ffd600',
  RED: '#e8002d',
  BLUE: '#0093cc',
  CHEQUERED: '#f0f0f0',
  BLACK: '#333',
  WHITE: '#f0f0f0',
  ORANGE: '#ff8000',
  CLEAR: '#00c853',
}

const TRACK_STATUS_COLOR: Record<string, string> = {
  '1': '#00c853',   // Green
  '2': '#ffd600',   // Yellow
  '4': '#ff8000',   // SafetyCar
  '5': '#e8002d',   // Red
  '6': '#ffd600',   // VSC
  '7': '#ff8000',   // VSCEnding
}

function formatUtc(utc: string): string {
  if (!utc) return ''
  // Backend sends absolute UTC timestamps like "2024-04-07 05:04:24"
  // Extract the time part and convert to local time display
  const timePart = utc.length >= 19 ? utc.slice(11, 19) : utc
  try {
    const d = new Date(utc.includes('T') ? utc : utc.replace(' ', 'T') + 'Z')
    if (!isNaN(d.getTime())) {
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`
    }
  } catch {/* fall through */}
  return timePart
}

export default function RaceControl({ messages, trackStatus }: RaceControlProps) {
  const statusColor = trackStatus ? (TRACK_STATUS_COLOR[trackStatus.status] ?? '#00c853') : '#00c853'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Track status bar */}
      <div
        className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-dark"
        style={{ borderLeftWidth: 3, borderLeftColor: statusColor, borderLeftStyle: 'solid' }}
      >
        <span className="font-mono text-xs tracking-widest uppercase" style={{ color: statusColor }}>
          {trackStatus?.message ?? 'Green'}
        </span>
        <span className="font-mono text-xs text-text-dim">Track Status</span>
      </div>

      {/* Messages list */}
      <div className="flex-1 overflow-y-auto flex flex-col divide-y divide-border-dark">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center flex-1 p-4">
            <span className="font-mono text-xs text-text-dim">No messages yet</span>
          </div>
        ) : (
          messages.map((msg, i) => {
            const flagColor = msg.flag ? (FLAG_COLOR[msg.flag.toUpperCase()] ?? '#888') : undefined
            return (
              <div key={i} className="flex gap-2 px-3 py-2">
                <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                  {flagColor && (
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: flagColor }} />
                  )}
                  {msg.lap != null && (
                    <span className="font-mono text-[9px] text-text-dim">L{msg.lap}</span>
                  )}
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-[10px] text-text-primary leading-snug">{msg.message}</span>
                  <span className="font-mono text-[9px] text-text-dim">{formatUtc(msg.utc)}</span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
