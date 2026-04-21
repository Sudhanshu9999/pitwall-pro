'use client'

// NOTE: This component uses pre-recorded positional telemetry from FastF1
// historical data, not live GPS tracking.

import { useEffect, useRef, useState } from 'react'
import { useDashboardStore } from '@/store/dashboardStore'
import type { CarPosition, TimingRow } from '@/types'

// ---------------------------------------------------------------------------
// Pure helpers (no React deps)
// ---------------------------------------------------------------------------

function buildTeamColors(timing: TimingRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of timing) {
    if (row.teamColour) out[row.code] = row.teamColour
  }
  return out
}

function buildPositionMap(timing: TimingRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of timing) {
    out[row.code] = row.position
  }
  return out
}

/**
 * Find the circuit point index nearest to (px, py).
 * Used to split the outline into sector-coloured segments.
 */
function findNearestIdx(points: [number, number][], px: number, py: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const dx = points[i][0] - px
    const dy = points[i][1] - py
    const d  = dx * dx + dy * dy
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

// ---------------------------------------------------------------------------
// Circuit cache — pre-render the track outline + S/F line + sector markers
// to an OffscreenCanvas so the rAF loop only has to drawImage() it each frame
// instead of rebuilding Path2D objects from hundreds of points every tick.
// ---------------------------------------------------------------------------

interface CircuitCache {
  offscreen: OffscreenCanvas
  /** Coordinate transforms matching the offscreen canvas — reused for car dots. */
  toX: (v: number) => number
  toY: (v: number) => number
  /** Non-zoomed scale — used to derive the zoomed transform on demand. */
  scale: number
  /** Canvas pixel dimensions when this cache was built (invalidated on resize). */
  w: number
  h: number
}

function buildCircuitCache(
  w: number,
  h: number,
  circuitPoints: [number, number][],
  sectorPoints: [number, number][] | undefined,
  startTangent: [number, number] | undefined,
  dpr: number,
): CircuitCache {
  const offscreen = new OffscreenCanvas(w, h)
  const ctx = offscreen.getContext('2d')!

  const PAD    = 16 * dpr
  const drawW  = w - 2 * PAD
  const drawH  = h - 2 * PAD

  // Bounds from circuit points only — stable across frames
  let minPX = Infinity, maxPX = -Infinity, minPY = Infinity, maxPY = -Infinity
  for (const [px, py] of circuitPoints) {
    if (px < minPX) minPX = px
    if (px > maxPX) maxPX = px
    if (py < minPY) minPY = py
    if (py > maxPY) maxPY = py
  }
  const trackW = (maxPX - minPX) || 1
  const trackH = (maxPY - minPY) || 1
  const scale  = Math.min(drawW / trackW, drawH / trackH)
  const offX   = PAD + (drawW - trackW * scale) / 2 - minPX * scale
  const offY   = PAD + (drawH - trackH * scale) / 2 + maxPY * scale
  const toX    = (v: number) => offX + v * scale
  const toY    = (v: number) => offY - v * scale

  const n = circuitPoints.length

  // ── Sector indices (computed once) ────────────────────────────────────────
  let s1Idx = -1, s2Idx = -1
  if (sectorPoints && sectorPoints.length >= 2) {
    s1Idx = findNearestIdx(circuitPoints, sectorPoints[0][0], sectorPoints[0][1])
    s2Idx = findNearestIdx(circuitPoints, sectorPoints[1][0], sectorPoints[1][1])
    if (s1Idx > s2Idx) [s1Idx, s2Idx] = [s2Idx, s1Idx]
  }

  // ── Circuit outline ───────────────────────────────────────────────────────
  if (s1Idx > 0 && s2Idx > 0) {
    const sectors: [number, number, string, string][] = [
      [0,     s1Idx, 'rgba(200,212,228,0.7)',  'rgba(180,200,220,0.15)'],
      [s1Idx, s2Idx, 'rgba(255,214,0,0.75)',   'rgba(255,214,0,0.12)'],
      [s2Idx, n - 1, 'rgba(232,0,45,0.75)',    'rgba(232,0,45,0.12)'],
    ]
    for (const [si, ei, color, glowColor] of sectors) {
      const p = new Path2D()
      p.moveTo(toX(circuitPoints[si][0]), toY(circuitPoints[si][1]))
      for (let i = si + 1; i <= Math.min(ei, n - 1); i++) {
        p.lineTo(toX(circuitPoints[i][0]), toY(circuitPoints[i][1]))
      }
      // Glow pass
      ctx.save()
      ctx.strokeStyle = glowColor
      ctx.lineWidth   = 14 * dpr
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.shadowBlur  = 18 * dpr
      ctx.shadowColor = glowColor
      ctx.stroke(p)
      ctx.restore()
      // Precise line
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth   = 3 * dpr
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.stroke(p)
      ctx.restore()
    }
  } else {
    const p = new Path2D()
    p.moveTo(toX(circuitPoints[0][0]), toY(circuitPoints[0][1]))
    for (let i = 1; i < n; i++) p.lineTo(toX(circuitPoints[i][0]), toY(circuitPoints[i][1]))
    p.closePath()
    // Glow pass
    ctx.save()
    ctx.strokeStyle = 'rgba(180,200,220,0.12)'
    ctx.lineWidth   = 14 * dpr
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.shadowBlur  = 18 * dpr
    ctx.shadowColor = 'rgba(180,200,220,0.15)'
    ctx.stroke(p)
    ctx.restore()
    // Precise line
    ctx.save()
    ctx.strokeStyle = 'rgba(210,218,228,0.65)'
    ctx.lineWidth   = 3 * dpr
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.stroke(p)
    ctx.restore()
  }

  // ── S/F line ──────────────────────────────────────────────────────────────
  if (startTangent && n >= 2) {
    const [tx, ty] = startTangent
    const perpX = -ty, perpY = tx
    const cx = toX(circuitPoints[0][0])
    const cy = toY(circuitPoints[0][1])
    const len = 12 * dpr
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(cx + perpX * len, cy - perpY * len)
    ctx.lineTo(cx - perpX * len, cy + perpY * len)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 3 * dpr
    ctx.lineCap     = 'round'
    ctx.stroke()
    ctx.restore()
    ctx.save()
    ctx.font         = `bold ${7 * dpr}px monospace`
    ctx.fillStyle    = 'rgba(255,255,255,0.7)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('S/F', cx + perpX * (len + 8 * dpr), cy - perpY * (len + 8 * dpr))
    ctx.restore()
  }

  // ── Sector boundary markers ───────────────────────────────────────────────
  if (sectorPoints) {
    const SECTOR_COLORS = ['#ffd600', '#e8002d']
    const SECTOR_LABELS = ['S2', 'S3']
    sectorPoints.forEach(([px, py], idx) => {
      const sx    = toX(px)
      const sy    = toY(py)
      const color = SECTOR_COLORS[idx] ?? '#ffd600'
      const label = SECTOR_LABELS[idx] ?? `S${idx + 2}`
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, 8 * dpr, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth   = 2 * dpr
      ctx.shadowBlur  = 12 * dpr
      ctx.shadowColor = color
      ctx.globalAlpha = 0.5
      ctx.stroke()
      ctx.restore()
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, 5 * dpr, 0, Math.PI * 2)
      ctx.fillStyle   = color
      ctx.shadowBlur  = 10 * dpr
      ctx.shadowColor = color
      ctx.fill()
      ctx.restore()
      ctx.save()
      const labelX = sx + 12 * dpr
      const labelY = sy - 2 * dpr
      ctx.font         = `bold ${8 * dpr}px monospace`
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      const tw  = ctx.measureText(label).width
      const pad = 2.5 * dpr
      const rx  = labelX - pad, ry = labelY - 5 * dpr
      const rw  = tw + pad * 2, rh = 10 * dpr, br = 2 * dpr
      ctx.fillStyle = 'rgba(10,10,15,0.8)'
      ctx.beginPath()
      ctx.moveTo(rx + br, ry)
      ctx.lineTo(rx + rw - br, ry)
      ctx.arcTo(rx + rw, ry, rx + rw, ry + br, br)
      ctx.lineTo(rx + rw, ry + rh - br)
      ctx.arcTo(rx + rw, ry + rh, rx + rw - br, ry + rh, br)
      ctx.lineTo(rx + br, ry + rh)
      ctx.arcTo(rx, ry + rh, rx, ry + rh - br, br)
      ctx.lineTo(rx, ry + br)
      ctx.arcTo(rx, ry, rx + br, ry, br)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = color
      ctx.fillText(label, labelX, labelY)
      ctx.restore()
    })
  }

  return { offscreen, toX, toY, scale, w, h }
}

/**
 * Linear interpolation between prev and target position maps.
 * Returns a new map; drivers absent from `prev` snap straight to target.
 */
function lerpPositions(
  prev: Record<string, CarPosition>,
  target: Record<string, CarPosition>,
  t: number,
): Record<string, CarPosition> {
  if (t >= 1) return target
  const out: Record<string, CarPosition> = {}
  for (const code in target) {
    const tgt = target[code]
    const prv = prev[code]
    if (prv) {
      const dx = tgt.x - prv.x
      const dy = tgt.y - prv.y
      // Skip interpolation for large jumps (S/F crossing or first appearance)
      if (dx * dx + dy * dy > 150 * 150) {
        out[code] = tgt
      } else {
        out[code] = { code, x: prv.x + dx * t, y: prv.y + dy * t, status: tgt.status }
      }
    } else {
      out[code] = tgt
    }
  }
  return out
}


// ---------------------------------------------------------------------------
// Paint — pure function, no React, no state.
//
// Fast path (non-zoomed + cache built): ctx.drawImage() the pre-rendered
// circuit, then draw only car dots — O(cars) instead of O(circuit_points).
// Slow path (zoomed or cache missing): full inline render.
//
// IMPORTANT: Uses a UNIFORM scale (Math.min of the two axis scales) so the
// circuit shape is never distorted by the card's aspect ratio.
// FastF1 Y increases upward; canvas Y increases downward — we flip Y.
// ---------------------------------------------------------------------------

function paintCarDots(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  positions: Record<string, CarPosition>,
  teamColors: Record<string, string>,
  selectedDriver: string | undefined,
  positionNumbers: Record<string, number> | undefined,
  toX: (v: number) => number,
  toY: (v: number) => number,
): void {
  const codes = Object.keys(positions).sort((a, b) =>
    a === selectedDriver ? 1 : b === selectedDriver ? -1 : 0
  )

  for (const code of codes) {
    const pos = positions[code]
    const cx  = toX(pos.x)
    const cy  = toY(pos.y)

    const isPit      = pos.status !== 'OnTrack' && pos.status !== 'ON_TRACK'
    const isSelected = code === selectedDriver
    const raw        = teamColors[code] ?? 'FFFFFF'
    const color      = raw.startsWith('#') ? raw : `#${raw}`
    const r          = (isSelected ? 7 : isPit ? 3 : 5) * dpr

    if (isSelected) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, r + 3 * dpr, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth   = 1.5 * dpr
      ctx.shadowBlur  = 8 * dpr
      ctx.shadowColor = 'rgba(255,255,255,0.6)'
      ctx.stroke()
      ctx.restore()
    }

    // Glow behind dot
    if (!isPit) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, r + 2 * dpr, 0, Math.PI * 2)
      ctx.fillStyle   = color
      ctx.globalAlpha = 0.25
      ctx.shadowBlur  = 10 * dpr
      ctx.shadowColor = color
      ctx.fill()
      ctx.restore()
    }

    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = isPit ? '#444' : color
    ctx.fill()
    ctx.restore()

    const posNum = positionNumbers?.[code]
    if (posNum !== undefined && !isPit) {
      const bx = cx - r - 1 * dpr
      const by = cy - r - 1 * dpr
      const br = 5 * dpr
      ctx.save()
      ctx.beginPath()
      ctx.arc(bx, by, br, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(10,10,15,0.85)'
      ctx.fill()
      ctx.font          = `bold ${7 * dpr}px monospace`
      ctx.fillStyle     = isSelected ? '#fff' : 'rgba(220,220,220,0.9)'
      ctx.textAlign     = 'center'
      ctx.textBaseline  = 'middle'
      ctx.fillText(String(posNum), bx, by)
      ctx.restore()
    }

    const labelAlpha = isSelected ? 0.95 : isPit ? 0.35 : 0.7
    ctx.save()
    ctx.font          = `${(isSelected ? 8 : 7) * dpr}px monospace`
    ctx.fillStyle     = `rgba(255,255,255,${labelAlpha})`
    ctx.textAlign     = 'center'
    ctx.textBaseline  = 'top'
    ctx.fillText(code, cx, cy + r + 2 * dpr)
    ctx.restore()
  }
}

function paint(
  canvas: HTMLCanvasElement,
  cache: CircuitCache | null,
  circuitPoints: [number, number][] | null,
  positions: Record<string, CarPosition>,
  teamColors: Record<string, string>,
  selectedDriver: string | undefined,
  isZoomed: boolean,
  sectorPoints?: [number, number][],
  startTangent?: [number, number],
  positionNumbers?: Record<string, number>,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const W   = canvas.width
  const H   = canvas.height

  ctx.clearRect(0, 0, W, H)

  // ── Fast path: cache available and not zoomed ─────────────────────────────
  if (cache && !isZoomed && cache.w === W && cache.h === H) {
    ctx.drawImage(cache.offscreen, 0, 0)
    paintCarDots(ctx, dpr, positions, teamColors, selectedDriver, positionNumbers, cache.toX, cache.toY)
    return
  }

  // ── Slow path: zoomed mode or cache not yet built ─────────────────────────
  if (!circuitPoints || circuitPoints.length === 0) return

  const PAD = 16 * dpr

  let minPX = Infinity, maxPX = -Infinity, minPY = Infinity, maxPY = -Infinity
  for (const [px, py] of circuitPoints) {
    if (px < minPX) minPX = px
    if (px > maxPX) maxPX = px
    if (py < minPY) minPY = py
    if (py > maxPY) maxPY = py
  }

  const trackW = (maxPX - minPX) || 1
  const trackH = (maxPY - minPY) || 1
  const drawW  = W - 2 * PAD
  const drawH  = H - 2 * PAD
  const scale  = Math.min(drawW / trackW, drawH / trackH)
  const offX   = PAD + (drawW - trackW * scale) / 2 - minPX * scale
  const offY   = PAD + (drawH - trackH * scale) / 2 + maxPY * scale

  let toX = (v: number) => offX + v * scale
  let toY = (v: number) => offY - v * scale

  if (isZoomed && selectedDriver) {
    const sel = positions[selectedDriver]
    if (sel) {
      const zs  = scale * 3.5
      const zOX = W / 2 - sel.x * zs
      const zOY = H / 2 + sel.y * zs
      toX = (v) => zOX + v * zs
      toY = (v) => zOY - v * zs
    }
  }

  // ── Circuit outline ───────────────────────────────────────────────────────
  const n = circuitPoints.length
  let s1Idx = -1, s2Idx = -1
  if (sectorPoints && sectorPoints.length >= 2) {
    s1Idx = findNearestIdx(circuitPoints, sectorPoints[0][0], sectorPoints[0][1])
    s2Idx = findNearestIdx(circuitPoints, sectorPoints[1][0], sectorPoints[1][1])
    if (s1Idx > s2Idx) [s1Idx, s2Idx] = [s2Idx, s1Idx]
  }

  if (s1Idx > 0 && s2Idx > 0) {
    const sectors: [number, number, string, string][] = [
      [0,     s1Idx, 'rgba(200,212,228,0.7)',  'rgba(180,200,220,0.15)'],
      [s1Idx, s2Idx, 'rgba(255,214,0,0.75)',   'rgba(255,214,0,0.12)'],
      [s2Idx, n - 1, 'rgba(232,0,45,0.75)',    'rgba(232,0,45,0.12)'],
    ]
    for (const [si, ei, color, glowColor] of sectors) {
      const p = new Path2D()
      p.moveTo(toX(circuitPoints[si][0]), toY(circuitPoints[si][1]))
      for (let i = si + 1; i <= Math.min(ei, n - 1); i++) {
        p.lineTo(toX(circuitPoints[i][0]), toY(circuitPoints[i][1]))
      }
      // Glow pass
      ctx.save()
      ctx.strokeStyle = glowColor
      ctx.lineWidth   = 14 * dpr
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.shadowBlur  = 18 * dpr
      ctx.shadowColor = glowColor
      ctx.stroke(p)
      ctx.restore()
      // Precise line
      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth   = 3 * dpr
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.stroke(p)
      ctx.restore()
    }
  } else {
    const p = new Path2D()
    p.moveTo(toX(circuitPoints[0][0]), toY(circuitPoints[0][1]))
    for (let i = 1; i < n; i++) p.lineTo(toX(circuitPoints[i][0]), toY(circuitPoints[i][1]))
    p.closePath()
    // Glow pass
    ctx.save()
    ctx.strokeStyle = 'rgba(180,200,220,0.12)'
    ctx.lineWidth   = 14 * dpr
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.shadowBlur  = 18 * dpr
    ctx.shadowColor = 'rgba(180,200,220,0.15)'
    ctx.stroke(p)
    ctx.restore()
    // Precise line
    ctx.save()
    ctx.strokeStyle = 'rgba(210,218,228,0.65)'
    ctx.lineWidth   = 3 * dpr
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.stroke(p)
    ctx.restore()
  }

  // ── Start/Finish line ─────────────────────────────────────────────────────
  if (startTangent && n >= 2) {
    const [tx, ty] = startTangent
    const perpX = -ty, perpY = tx
    const cx = toX(circuitPoints[0][0])
    const cy = toY(circuitPoints[0][1])
    const len = 12 * dpr
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(cx + perpX * len, cy - perpY * len)
    ctx.lineTo(cx - perpX * len, cy + perpY * len)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth   = 3 * dpr
    ctx.lineCap     = 'round'
    ctx.stroke()
    ctx.restore()
    ctx.save()
    ctx.font         = `bold ${7 * dpr}px monospace`
    ctx.fillStyle    = 'rgba(255,255,255,0.7)'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('S/F', cx + perpX * (len + 8 * dpr), cy - perpY * (len + 8 * dpr))
    ctx.restore()
  }

  // ── Sector boundary markers ───────────────────────────────────────────────
  if (sectorPoints) {
    const SECTOR_COLORS = ['#ffd600', '#e8002d']
    const SECTOR_LABELS = ['S2', 'S3']
    sectorPoints.forEach(([px, py], idx) => {
      const sx    = toX(px)
      const sy    = toY(py)
      const color = SECTOR_COLORS[idx] ?? '#ffd600'
      const label = SECTOR_LABELS[idx] ?? `S${idx + 2}`
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, 8 * dpr, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth   = 2 * dpr
      ctx.shadowBlur  = 12 * dpr
      ctx.shadowColor = color
      ctx.globalAlpha = 0.5
      ctx.stroke()
      ctx.restore()
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, 5 * dpr, 0, Math.PI * 2)
      ctx.fillStyle   = color
      ctx.shadowBlur  = 10 * dpr
      ctx.shadowColor = color
      ctx.fill()
      ctx.restore()
      ctx.save()
      const labelX = sx + 12 * dpr
      const labelY = sy - 2 * dpr
      ctx.font         = `bold ${8 * dpr}px monospace`
      ctx.textAlign    = 'left'
      ctx.textBaseline = 'middle'
      const tw  = ctx.measureText(label).width
      const pad = 2.5 * dpr
      const rx  = labelX - pad, ry = labelY - 5 * dpr
      const rw  = tw + pad * 2, rh = 10 * dpr, br = 2 * dpr
      ctx.fillStyle = 'rgba(10,10,15,0.8)'
      ctx.beginPath()
      ctx.moveTo(rx + br, ry)
      ctx.lineTo(rx + rw - br, ry)
      ctx.arcTo(rx + rw, ry, rx + rw, ry + br, br)
      ctx.lineTo(rx + rw, ry + rh - br)
      ctx.arcTo(rx + rw, ry + rh, rx + rw - br, ry + rh, br)
      ctx.lineTo(rx + br, ry + rh)
      ctx.arcTo(rx, ry + rh, rx, ry + rh - br, br)
      ctx.lineTo(rx, ry + br)
      ctx.arcTo(rx, ry, rx + br, ry, br)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = color
      ctx.fillText(label, labelX, labelY)
      ctx.restore()
    })
  }

  // ── Car dots ──────────────────────────────────────────────────────────────
  paintCarDots(ctx, dpr, positions, teamColors, selectedDriver, positionNumbers, toX, toY)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TrackMapProps {
  /** When set, only render dots for these driver codes (e.g. ['VER', 'HAM']). */
  filterDrivers?: string[]
}

export default function TrackMap({ filterDrivers }: TrackMapProps) {
  const canvasRef        = useRef<HTMLCanvasElement>(null)
  const rafIdRef         = useRef<number>(0)
  const circuitCacheRef  = useRef<CircuitCache | null>(null)
  const circuitDirtyRef  = useRef(true)
  const [isZoomed, setIsZoomed] = useState(false)
  // Flash notice driven by the backend's position_recalibrated frame
  const [notice, setNotice]   = useState<string | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filterRef = useRef<string[] | undefined>(filterDrivers)

  const hasCircuit      = useDashboardStore(s => (s.circuitOutline?.points.length ?? 0) > 0)
  const hasTelemetry    = useDashboardStore(s => s.hasTelemetry)
  const wsReady         = useDashboardStore(s => s.wsReady)
  const positionNotice  = useDashboardStore(s => s.positionNotice)

  // ── Rendering refs — updated by subscription, read by rAF (no re-renders) ─
  const isZoomedRef       = useRef(false)
  const circuitPointsRef  = useRef<[number, number][] | null>(null)
  const sectorPointsRef   = useRef<[number, number][] | undefined>(undefined)
  const startTangentRef   = useRef<[number, number] | undefined>(undefined)
  const teamColorsRef     = useRef<Record<string, string>>({})
  const positionMapRef    = useRef<Record<string, number>>({})
  const selectedDriverRef = useRef<string | undefined>(undefined)
  const pendingRef        = useRef(true)

  // ── Interpolation refs ────────────────────────────────────────────────────
  // Rolling buffer of the last 4 position snapshots with timestamps.
  // The rAF loop renders at (now - renderDelay), always interpolating between
  // two known frames — no extrapolation, no overshoot, no back-and-forth stutter.
  const posBufferRef      = useRef<Array<{ t: number; map: Record<string, CarPosition> }>>([])
  const lastRafRef        = useRef(0)
  const lastUpdateRef     = useRef(0)
  const updateIntervalRef = useRef(300) // ms between position updates — adapts at runtime
  const posArrayRef       = useRef<CarPosition[]>([])
  const prevTimingRef     = useRef<TimingRow[]>([])


  useEffect(() => {
    isZoomedRef.current     = isZoomed
    // When un-zooming, force a cache check so the circuit re-blits correctly
    if (!isZoomed) circuitDirtyRef.current = true
    pendingRef.current      = true
  }, [isZoomed])

  useEffect(() => {
    filterRef.current  = filterDrivers
    pendingRef.current = true
  }, [filterDrivers])

  // ── Store subscription ────────────────────────────────────────────────────
  useEffect(() => {
    const init = useDashboardStore.getState()
    circuitPointsRef.current  = init.circuitOutline?.points ?? null
    sectorPointsRef.current   = init.circuitOutline?.sectorPoints ?? undefined
    startTangentRef.current   = init.circuitOutline?.startTangent ?? undefined
    teamColorsRef.current     = buildTeamColors(init.timing)
    positionMapRef.current    = buildPositionMap(init.timing)
    selectedDriverRef.current = init.activeSession?.driverA
    prevTimingRef.current     = init.timing
    pendingRef.current        = true

    return useDashboardStore.subscribe((state) => {
      const newPoints = state.circuitOutline?.points ?? null
      if (newPoints !== circuitPointsRef.current) {
        circuitPointsRef.current = newPoints
        circuitDirtyRef.current  = true
      }
      sectorPointsRef.current   = state.circuitOutline?.sectorPoints ?? undefined
      startTangentRef.current   = state.circuitOutline?.startTangent ?? undefined
      selectedDriverRef.current = state.activeSession?.driverA

      if (state.timing !== prevTimingRef.current) {
        prevTimingRef.current  = state.timing
        teamColorsRef.current  = buildTeamColors(state.timing)
        positionMapRef.current = buildPositionMap(state.timing)
      }

      pendingRef.current = true

      if (state.carPositions !== posArrayRef.current) {
        posArrayRef.current = state.carPositions

        const now      = performance.now()
        const interval = now - lastUpdateRef.current
        // Track the rolling update interval so renderDelay can adapt.
        // Clamp to [20, 600] ms to ignore outliers (first frame, paused state).
        if (interval > 20 && interval < 600) {
          // Exponential moving average — smooths out single outlier intervals
          updateIntervalRef.current = updateIntervalRef.current * 0.7 + interval * 0.3
        }
        lastUpdateRef.current = now

        const filteredPositions = filterRef.current
          ? state.carPositions.filter((p) => filterRef.current!.includes(p.code))
          : state.carPositions

        const newMap: Record<string, CarPosition> = {}
        for (const p of filteredPositions) newMap[p.code] = p

        posBufferRef.current.push({ t: now, map: newMap })
        // Keep last 6 frames — enough for smooth interpolation at any replay speed
        while (posBufferRef.current.length > 6) posBufferRef.current.shift()
      }
    })
  }, [])

  // When the store receives a position_recalibrated notice, show it for 5 s then clear
  useEffect(() => {
    if (!positionNotice) return
    setNotice(positionNotice)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => {
      setNotice(null)
      useDashboardStore.getState().setPositionNotice(null)
    }, 5000)
  }, [positionNotice])

  // Clean up timer on unmount
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current) }, [])

  // ── ResizeObserver ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const dpr     = window.devicePixelRatio || 1
      canvas.width  = canvas.offsetWidth  * dpr
      canvas.height = canvas.offsetHeight * dpr
      circuitDirtyRef.current = true
      pendingRef.current      = true
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [])

  // ── rAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const tick = (timestamp: number) => {
      // Cap at 60 fps — skip frames that arrive sooner than ~16.7 ms
      if (timestamp - lastRafRef.current < 16) {
        rafIdRef.current = requestAnimationFrame(tick)
        return
      }
      lastRafRef.current = timestamp

      const now = performance.now()
      const buf = posBufferRef.current

      // Render delay must exceed the update interval so that when renderTime
      // reaches frame A, frame B is already in the buffer.
      // renderDelay = 1.5 × updateInterval guarantees this with a 50% margin.
      // Minimum 200 ms so high-speed replay (10x, ~25 ms interval) still has
      // enough buffer to stay between two known frames.
      const renderDelay = Math.max(updateIntervalRef.current * 1.5, 200)
      const renderTime  = now - renderDelay

      // Keep painting until 3 update intervals after the last received frame
      // so the lerp fully completes; after that idle until pendingRef fires.
      const lastFrameAge = buf.length > 0 ? now - buf[buf.length - 1].t : Infinity
      const hasMotion    = lastFrameAge < updateIntervalRef.current * 3

      // Rebuild the circuit cache whenever the outline changes or canvas resizes.
      // This runs at most once per circuit load / resize — O(circuit_points).
      // All subsequent frames use the cached OffscreenCanvas via drawImage().
      if (circuitDirtyRef.current) {
        const pts = circuitPointsRef.current
        if (pts && pts.length > 1 && canvas.width > 0 && canvas.height > 0) {
          circuitCacheRef.current = buildCircuitCache(
            canvas.width,
            canvas.height,
            pts,
            sectorPointsRef.current,
            startTangentRef.current,
            window.devicePixelRatio || 1,
          )
        } else {
          circuitCacheRef.current = null
        }
        circuitDirtyRef.current = false
      }

      if (pendingRef.current || hasMotion) {
        pendingRef.current = false

        let positions: Record<string, CarPosition> = {}

        if (buf.length >= 2) {
          // Find the last frame whose timestamp is ≤ renderTime (frame A),
          // and the frame immediately after it (frame B).
          let aIdx = 0
          for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i + 1].t <= renderTime) aIdx = i + 1
          }
          const a = buf[aIdx]
          const b = buf[Math.min(aIdx + 1, buf.length - 1)]

          if (renderTime >= b.t) {
            // renderTime is past the newest buffered frame — hold at newest.
            // This can only happen when frames stop arriving (replay paused).
            positions = b.map
          } else {
            const t = (renderTime - a.t) / Math.max(b.t - a.t, 1)
            positions = lerpPositions(a.map, b.map, Math.min(Math.max(t, 0), 1))
          }
        } else if (buf.length === 1) {
          positions = buf[0].map
        }

        paint(
          canvas,
          circuitCacheRef.current,
          circuitPointsRef.current,
          positions,
          teamColorsRef.current,
          selectedDriverRef.current,
          isZoomedRef.current,
          sectorPointsRef.current,
          startTangentRef.current,
          positionMapRef.current,
        )
      }

      rafIdRef.current = requestAnimationFrame(tick)
    }

    rafIdRef.current = requestAnimationFrame((ts) => tick(ts))
    return () => cancelAnimationFrame(rafIdRef.current)
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        aria-label="Circuit track map with car positions"
      />

      <button
        onClick={() => setIsZoomed(z => !z)}
        className="absolute top-2 right-2 font-mono text-[9px] text-text-dim hover:text-text-muted border border-border-dark px-1.5 py-0.5 transition-colors hover:border-border-accent bg-bg-primary/80"
      >
        {isZoomed ? 'FULL' : 'ZOOM'}
      </button>

      {notice && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none animate-fade-in-out z-10">
          <div className="flex items-center gap-1.5 bg-bg-primary/95 border border-flag-yellow/50 px-3 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-flag-yellow shrink-0 animate-blink" />
            <span className="font-mono text-[9px] tracking-widest uppercase text-flag-yellow whitespace-nowrap">
              {notice}
            </span>
          </div>
        </div>
      )}

      {!hasCircuit && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <svg viewBox="0 0 80 80" className="w-16 h-16 opacity-10">
            <path
              d="M10 40 C10 22,22 10,40 10 C58 10,70 22,70 40 C70 54,62 62,52 65 C42 68,32 62,22 56 C12 50,10 46,10 40Z"
              fill="none" stroke="#e8002d" strokeWidth="4"
            />
          </svg>
          {wsReady && hasTelemetry === false ? (
            <span className="font-mono text-[10px] text-text-dim text-center px-4">
              Position data unavailable<br />
              <span className="text-text-dim opacity-60">(locked by F1 since Aug 2025)</span>
            </span>
          ) : (
            <span className="font-mono text-[10px] text-text-dim">Waiting for circuit data…</span>
          )}
        </div>
      )}
    </div>
  )
}
