'use client'

import { useEffect, useRef } from 'react'

interface CircuitOutline {
  points: [number, number][]
  bounds: { min_x: number; max_x: number; min_y: number; max_y: number }
  sector_points?: [number, number][]
  start_tangent?: [number, number]
}

interface Props {
  outline: CircuitOutline
  dotCount?: number
  trackOpacity?: number
  trailLength?: number
}

function buildTransform(w: number, h: number, points: [number, number][], dpr: number) {
  const PAD   = 32 * dpr
  const drawW = w - 2 * PAD
  const drawH = h - 2 * PAD

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [px, py] of points) {
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }

  const trackW = (maxX - minX) || 1
  const trackH = (maxY - minY) || 1
  const scale  = Math.min(drawW / trackW, drawH / trackH)
  const offX   = PAD + (drawW - trackW * scale) / 2 - minX * scale
  const offY   = PAD + (drawH - trackH * scale) / 2 + maxY * scale

  return {
    toX: (v: number) => offX + v * scale,
    toY: (v: number) => offY - v * scale,
  }
}

function buildArcLengths(points: [number, number][]): number[] {
  const arc = [0]
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0]
    const dy = points[i][1] - points[i - 1][1]
    arc.push(arc[i - 1] + Math.sqrt(dx * dx + dy * dy))
  }
  return arc
}

function pointAtFraction(t: number, points: [number, number][], arc: number[]): [number, number] {
  const total  = arc[arc.length - 1]
  const target = ((t % 1) + 1) % 1 * total
  let lo = 0, hi = arc.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arc[mid + 1] < target) lo = mid + 1
    else hi = mid
  }
  const seg  = arc[lo + 1] - arc[lo]
  const frac = seg > 0 ? (target - arc[lo]) / seg : 0
  const a = points[lo], b = points[lo + 1] ?? points[lo]
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
}

const DOT_COLORS = ['#e8002d', '#ff8c00']

export default function CircuitMini({
  outline,
  dotCount    = 2,
  trackOpacity = 0.22,
  trailLength  = 12,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number>(0)
  // Fractional position along the circuit for each car
  const tRef      = useRef<number[]>(
    Array.from({ length: dotCount }, (_, i) => i / dotCount),
  )
  // Circular trail buffers: [carIdx][slotIdx] = {cx, cy}
  const trailRef  = useRef<{ cx: number; cy: number }[][]>(
    Array.from({ length: dotCount }, () => []),
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const { points } = outline
    const arc = buildArcLengths(points)

    let w = 0, h = 0
    let xfCache: ReturnType<typeof buildTransform> | null = null
    let glowPath: Path2D | null = null
    let trackPath: Path2D | null = null

    function resize() {
      const rect = canvas.getBoundingClientRect()
      w = Math.round(rect.width  * dpr)
      h = Math.round(rect.height * dpr)
      canvas.width  = w
      canvas.height = h
      xfCache   = null
      glowPath  = null
      trackPath = null
      // Clear trails on resize so old canvas coords don't bleed in
      for (let i = 0; i < dotCount; i++) trailRef.current[i] = []
    }

    function xf() {
      if (!xfCache) xfCache = buildTransform(w, h, points, dpr)
      return xfCache
    }

    function buildPaths() {
      if (trackPath) return
      const { toX, toY } = xf()
      const g = new Path2D()
      const p = new Path2D()
      g.moveTo(toX(points[0][0]), toY(points[0][1]))
      p.moveTo(toX(points[0][0]), toY(points[0][1]))
      for (let i = 1; i < points.length; i++) {
        g.lineTo(toX(points[i][0]), toY(points[i][1]))
        p.lineTo(toX(points[i][0]), toY(points[i][1]))
      }
      g.closePath()
      p.closePath()
      glowPath  = g
      trackPath = p
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    const SPEED = 0.045
    let lastTime = 0

    function draw(timestamp: number) {
      const dt = lastTime ? (timestamp - lastTime) / 1000 : 0
      lastTime = timestamp

      const ctx = canvas.getContext('2d')
      if (!ctx || w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }

      ctx.clearRect(0, 0, w, h)
      buildPaths()

      const { toX, toY } = xf()

      // ── Glow pass ─────────────────────────────────────────────────────────
      ctx.save()
      ctx.strokeStyle = `rgba(232,0,45,0.05)`
      ctx.lineWidth   = 14 * dpr
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.shadowBlur  = 24 * dpr
      ctx.shadowColor = 'rgba(232,0,45,0.08)'
      ctx.stroke(glowPath!)
      ctx.restore()

      // ── Precise track line ─────────────────────────────────────────────────
      ctx.save()
      ctx.strokeStyle = `rgba(232,0,45,${trackOpacity})`
      ctx.lineWidth   = 2 * dpr
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.stroke(trackPath!)
      ctx.restore()

      // ── Cars + comet trails ────────────────────────────────────────────────
      for (let i = 0; i < dotCount; i++) {
        tRef.current[i] = (tRef.current[i] + SPEED * dt) % 1
        const [px, py] = pointAtFraction(tRef.current[i], points, arc)
        const cx = toX(px)
        const cy = toY(py)
        const color = DOT_COLORS[i % DOT_COLORS.length]

        // Push to trail buffer
        const trail = trailRef.current[i]
        trail.push({ cx, cy })
        if (trail.length > trailLength) trail.shift()

        // Derive rgb components from the car color index (avoids string mangling)
        const [r, g, b] = i === 0 ? [232, 0, 45] : [255, 140, 0]

        // Draw trail oldest → newest
        for (let j = 0; j < trail.length; j++) {
          const age    = j / trail.length        // 0 = oldest, 1 = newest
          const alpha  = age * age * 0.8         // quadratic fade
          const radius = (1.5 + 3 * age) * dpr  // grows toward head
          ctx.save()
          ctx.beginPath()
          ctx.arc(trail[j].cx, trail[j].cy, radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
          ctx.fill()
          ctx.restore()
        }

        // Car head — outer glow
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, 5 * dpr, 0, Math.PI * 2)
        ctx.fillStyle   = color
        ctx.shadowBlur  = 16 * dpr
        ctx.shadowColor = color
        ctx.fill()
        ctx.restore()

        // Car head — bright white core
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, 2 * dpr, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.restore()
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [outline, dotCount, trackOpacity, trailLength])

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ display: 'block' }}
    />
  )
}
