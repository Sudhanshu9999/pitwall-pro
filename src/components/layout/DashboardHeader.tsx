'use client'

import Link from 'next/link'
import { SessionMode } from '@/types'

interface DashboardHeaderProps {
  mode: SessionMode
  onModeChange: (mode: SessionMode) => void
  sessionLabel?: string
  isLive?: boolean
}

export default function DashboardHeader({
  mode,
  onModeChange,
  sessionLabel = 'NO ACTIVE SESSION',
  isLive = false,
}: DashboardHeaderProps) {
  return (
    <header className="flex items-center justify-between px-4 sm:px-6 h-14 border-b border-border-dark bg-bg-secondary shrink-0">

      {/* Left — Logo */}
      <Link href="/" className="flex items-center gap-2.5 shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-f1-red animate-pulse-red" />
        <span className="font-display text-xs font-bold text-text-primary tracking-widest uppercase hidden sm:block">
          PitWall Pro
        </span>
        <span className="font-display text-xs font-bold text-text-primary tracking-widest uppercase sm:hidden">
          PW
        </span>
      </Link>

      {/* Center — Toggle + Session Label */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-0 border border-border-dark">
          <button
            onClick={() => onModeChange('live')}
            className={`px-4 py-1.5 font-display text-xs font-bold tracking-widest uppercase transition-colors duration-150 ${
              mode === 'live' ? 'bg-f1-red text-white' : 'bg-transparent text-text-dim hover:text-text-muted'
            }`}
          >
            {mode === 'live' && isLive && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-white mr-2 animate-pulse-red" />
            )}
            Live
          </button>
          <button
            onClick={() => onModeChange('archive')}
            className={`px-4 py-1.5 font-display text-xs font-bold tracking-widest uppercase transition-colors duration-150 ${
              mode === 'archive' ? 'bg-f1-red text-white' : 'bg-transparent text-text-dim hover:text-text-muted'
            }`}
          >
            Archive
          </button>
        </div>
        <span className="font-mono text-[10px] sm:text-xs text-text-dim tracking-widest max-w-[140px] sm:max-w-none truncate text-center">
          {sessionLabel}
        </span>
      </div>

      {/* Right — Actions */}
      <div className="flex items-center gap-3 shrink-0">
        <button className="hidden sm:flex items-center gap-2 px-3 py-1.5 border border-border-dark font-mono text-xs text-text-dim hover:border-border-accent hover:text-text-muted transition-colors">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 3h10M1 6h7M1 9h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="hidden sm:inline">Ask AI</span>
        </button>

        <button
          onClick={() => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()}
          className="p-1.5 border border-border-dark text-text-dim hover:text-text-muted hover:border-border-accent transition-colors"
          title="Toggle Fullscreen"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
    </header>
  )
}