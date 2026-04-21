'use client'

import { useEffect, useState } from 'react'
import CircuitMini from './CircuitMini'

interface CircuitOutline {
  points: [number, number][]
  bounds: { min_x: number; max_x: number; min_y: number; max_y: number }
  sector_points?: [number, number][]
  start_tangent?: [number, number]
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

async function fetchOutline(year: number, gp: string): Promise<CircuitOutline | null> {
  try {
    const res = await fetch(
      `${API_BASE}/api/archive/circuit?year=${year}&gp=${encodeURIComponent(gp)}&session=Race`,
      { cache: 'force-cache' },
    )
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export default function TrackHero() {
  const [outline, setOutline] = useState<CircuitOutline | null>(null)

  useEffect(() => {
    fetchOutline(2024, 'Japanese').then(setOutline)
  }, [])

  if (!outline) return null

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">

      {/* Mobile / Tablet (<lg): full-screen watermark behind content */}
      <div
        className="lg:hidden absolute inset-0"
        style={{ opacity: outline ? 1 : 0, transition: 'opacity 1.2s ease' }}
      >
        <CircuitMini
          outline={outline}
          dotCount={1}
          trackOpacity={0.16}
          trailLength={6}
        />
      </div>

      {/* Desktop (lg+): right-half panel only — left stays pure black */}
      <div
        className="hidden lg:block absolute inset-y-0 right-0 w-[65%]"
        style={{ opacity: outline ? 1 : 0, transition: 'opacity 1.2s ease' }}
      >
        <CircuitMini
          outline={outline}
          dotCount={2}
          trackOpacity={0.22}
          trailLength={12}
        />
      </div>

    </div>
  )
}
