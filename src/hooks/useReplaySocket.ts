'use client'

/**
 * useReplaySocket
 *
 * Manages a single WebSocket connection for either archive replay or live stream.
 * Dispatches incoming frames to the Zustand dashboard store.
 * Registers a sendControl function in the store so any component can send
 * control messages (speed, pause, resume, stop) without needing a prop chain.
 *
 * Mount this once in dashboard/layout.tsx. It reconnects automatically whenever
 * the `url` argument changes (i.e. when a new session is selected).
 *
 * tel_update frames use a flat format:
 *   { frame_type: 'tel_update', driver: 'VER', speed, throttle, brake, gear, rpm, drs }
 * These are batched for 100ms before flushing to the store to avoid excessive
 * re-renders at high replay speeds (10x → ~40 frames/s).
 */

import { useEffect, useRef } from 'react'
import { useDashboardStore } from '@/store/dashboardStore'
import type { CarTelemetry, CarPosition, CircuitOutline } from '@/types'

export function useReplaySocket(url: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  // Accumulate tel_update frames between 100ms flush ticks
  const telBatchRef = useRef<Record<string, CarTelemetry>>({})
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    setWsReady,
    setWsError,
    setReplayPaused,
    applyLapFrame,
    updateCarData,
    updateTimingGaps,
    setCircuitOutline,
    setCarPositions,
    setPositionNotice,
    addRaceControlMessage,
    setTrackStatus,
    registerSendControl,
    resetStream,
  } = useDashboardStore.getState()

  // Send control message to the open socket
  function sendControl(action: string, value?: string) {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(value !== undefined ? { action, value } : { action }))
  }

  useEffect(() => {
    // Register sendControl so dashboard/page.tsx can call it via the store
    registerSendControl(sendControl)

    if (!url) {
      resetStream()
      return
    }

    resetStream()
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      setWsError(null)
      // wsReady is NOT set here — we wait for a real lap frame before
      // switching the UI from "No session" to the live dashboard.
    }

    ws.onmessage = (event) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(event.data as string)
      } catch {
        return
      }

      const type = frame.frame_type as string

      if (type === 'lap') {
        setWsReady(true)
        applyLapFrame(frame.payload as Parameters<typeof applyLapFrame>[0])
      } else if (type === 'tel_update') {
        // Flat format: { frame_type, driver, speed, throttle, brake, gear, rpm, drs }
        const driverCode = frame.driver as string | undefined
        if (driverCode) {
          telBatchRef.current[driverCode] = {
            speed:    frame.speed    as number,
            throttle: frame.throttle as number,
            brake:    frame.brake    as number,
            gear:     frame.gear     as number,
            rpm:      frame.rpm      as number,
            drs:      frame.drs      as number,
          }
          // Schedule a flush if not already pending
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(() => {
              const batch = telBatchRef.current
              telBatchRef.current = {}
              flushTimerRef.current = null
              if (Object.keys(batch).length > 0) updateCarData(batch)
            }, 100)
          }
        }
      } else if (type === 'circuit_outline') {
        const rawSP = frame.sector_points as number[][] | undefined
        const rawST = frame.start_tangent as number[] | undefined
        setCircuitOutline({
          points: frame.points as [number, number][],
          bounds: frame.bounds as CircuitOutline['bounds'],
          // Guard: backend returns [] when data is unavailable — treat as undefined
          sectorPoints: rawSP && rawSP.length >= 2 ? rawSP as [number, number][] : undefined,
          startTangent: rawST && rawST.length === 2 ? rawST as [number, number] : undefined,
        }, frame.has_telemetry as boolean | undefined)
      } else if (type === 'position_update') {
        setCarPositions(frame.positions as CarPosition[])
      } else if (type === 'timing_update') {
        const rows = frame.rows as { code: string; gap: string; interval: string }[] | undefined
        if (rows?.length) updateTimingGaps(rows)
      } else if (type === 'rc_message') {
        const msg = frame.msg as import('@/types').RaceControlMessage | undefined
        if (msg) addRaceControlMessage(msg)
      } else if (type === 'track_status_update') {
        setTrackStatus({ status: frame.status as string, message: frame.message as string })
      } else if (type === 'position_recalibrated') {
        const affected = frame.affected as number
        const total    = frame.total as number
        const lap      = frame.lap as number
        const notice   = `LAP ${lap} — gap-adjusted positioning activated (${affected}/${total} drivers recalculated)`
        setPositionNotice(notice)
      } else if (type === 'end') {
        setReplayPaused(true)
      } else if (type === 'no_session') {
        setWsError('No active F1 session right now.')
      } else if (type === 'error') {
        const msg = (frame.payload as { message?: string })?.message ?? 'Stream error'
        setWsError(msg)
      }
      // session_info frames are informational — no store update needed currently
    }

    ws.onerror = () => {
      setWsError('WebSocket connection error')
      setWsReady(false)
    }

    ws.onclose = () => {
      setWsReady(false)
    }

    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      telBatchRef.current = {}
      ws.close()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
}
