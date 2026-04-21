'use client'

import { useState } from 'react'

const DRIVERS = ['VER', 'NOR', 'LEC', 'SAI', 'HAM', 'RUS', 'PIA', 'ALO', 'STR', 'GAS', 'OCO', 'TSU', 'HUL', 'MAG', 'BOT', 'ZHO', 'DEV', 'LAW', 'COL', 'BEA']

const TEAM_COLORS: Record<string, string> = {
  VER: '#3671c6', NOR: '#ff8000', LEC: '#e8002d', SAI: '#e8002d',
  HAM: '#27f4d2', RUS: '#27f4d2', PIA: '#ff8000', ALO: '#358c75',
  STR: '#358c75', GAS: '#0093cc', OCO: '#0093cc', TSU: '#6692ff',
  HUL: '#ffffff', MAG: '#ffffff', BOT: '#900000', ZHO: '#900000',
  DEV: '#6692ff', LAW: '#6692ff', COL: '#ff8000', BEA: '#3671c6',
}

interface DriverPickerProps {
  excludeDriver?: string
  onConfirm: (driver: string) => void
  onClose: () => void
}

export default function DriverPicker({ excludeDriver, onConfirm, onClose }: DriverPickerProps) {
  const [selected, setSelected] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(8,8,8,0.97)' }}>
      <div className="w-full max-w-sm border border-border-dark bg-bg-secondary">
        <div className="h-px w-full bg-f1-red" />
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-dark">
          <div>
            <span className="font-mono text-xs text-f1-red tracking-widest uppercase">Compare Mode</span>
            <h3 className="font-display text-sm font-bold text-text-primary tracking-wider uppercase mt-0.5">
              Select Second Driver
            </h3>
          </div>
          <button onClick={onClose} className="text-text-dim hover:text-text-muted transition-colors p-1">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="p-5">
          <div className="flex flex-wrap gap-2">
            {DRIVERS.filter(d => d !== excludeDriver).map(d => (
              <button
                key={d}
                onClick={() => setSelected(d)}
                className={`px-3 py-1.5 font-mono text-xs border transition-colors ${
                  selected === d ? 'border-f1-red bg-f1-red-muted' : 'border-border-dark text-text-dim hover:border-border-accent'
                }`}
                style={{ color: selected === d ? TEAM_COLORS[d] : undefined }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-dark">
          <span className="font-mono text-xs text-text-dim">
            {selected ? `Selected: ${selected}` : 'Pick a driver'}
          </span>
          <button
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
            className={`px-6 py-2.5 font-display text-xs font-bold tracking-widest uppercase transition-colors ${
              selected ? 'bg-f1-red text-white hover:bg-f1-red-bright' : 'bg-border-dark text-text-dim cursor-not-allowed'
            }`}
          >
            Compare →
          </button>
        </div>
      </div>
    </div>
  )
}