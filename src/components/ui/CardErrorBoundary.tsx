'use client'

import { Component, ReactNode } from 'react'

interface Props {
  title: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Lightweight error boundary scoped to a single DashCard.
 * A crash inside one card shows an inline error instead of
 * taking down the entire dashboard.
 */
export default class CardErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[CardErrorBoundary] "${this.props.title}" crashed:`, error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 px-4 py-3">
          <span className="font-mono text-[10px] text-f1-red tracking-widest uppercase">
            Error
          </span>
          <span className="font-mono text-[10px] text-text-dim text-center leading-relaxed max-w-[180px]">
            {this.state.error.message || 'This card failed to render.'}
          </span>
          <button
            onClick={() => this.setState({ error: null })}
            className="font-mono text-[9px] text-text-dim border border-border-dark px-2 py-1 hover:border-f1-red hover:text-f1-red transition-colors mt-1"
          >
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
