'use client'

import { ReactNode } from 'react'
import CardErrorBoundary from './CardErrorBoundary'

interface DashCardProps {
  title: string
  tag?: string
  children?: ReactNode
  className?: string
  accent?: string
  status?: 'live' | 'loading' | 'empty' | 'ready'
}

export default function DashCard({
  title,
  tag,
  children,
  className = '',
  accent = '#e8002d',
  status = 'empty',
}: DashCardProps) {
  return (
    <div className={`relative flex flex-col bg-bg-card border border-border-dark overflow-hidden ${className}`}>
      {/* Top accent line */}
      <div className="h-px w-full shrink-0" style={{ background: accent }} />

      {/* Card header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-dark shrink-0">
        <div className="flex items-center gap-2">
          {status === 'live' && (
            <span className="w-1.5 h-1.5 rounded-full bg-flag-green animate-pulse-red shrink-0" />
          )}
          <span className="font-display text-xs font-semibold text-text-primary tracking-widest uppercase">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {tag && (
            <span className="font-mono text-xs text-text-dim">{tag}</span>
          )}
          {status === 'loading' && (
            <div className="w-3 h-3 border border-text-dim border-t-f1-red rounded-full animate-spin" />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <CardErrorBoundary title={title}>
          {children ?? (
            <div className="flex-1 flex items-center justify-center">
              <span className="font-mono text-xs text-text-dim tracking-widest">
                — NO DATA —
              </span>
            </div>
          )}
        </CardErrorBoundary>
      </div>
    </div>
  )
}