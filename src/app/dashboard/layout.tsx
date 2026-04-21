'use client'

import { useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import DashboardHeader from '@/components/layout/DashboardHeader'
import SessionSelector from '@/components/dashboard/SessionSelector'
import { useDashboardStore, SessionParams } from '@/store/dashboardStore'
import { SessionMode, SessionType } from '@/types'
import { useReplaySocket } from '@/hooks/useReplaySocket'
import { archiveReplayUrl, liveStreamUrl } from '@/lib/api'

function SearchParamsSync() {
  const searchParams = useSearchParams()
  const { mode, activeSession, setMode, setShowSelector, setActiveSession, resetStream } = useDashboardStore()

  useEffect(() => {
    const urlMode = searchParams.get('mode') as SessionMode | null
    const targetMode: SessionMode = urlMode === 'archive' ? 'archive' : 'live'
    if (targetMode !== mode) {
      setMode(targetMode)
      if (targetMode === 'live') {
        // Clear any stale archive session so the live "no session" view renders cleanly
        setActiveSession(null)
        resetStream()
      }
      if (targetMode === 'archive' && !activeSession) setShowSelector(true)
    }
  }, [])

  return null
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { mode, activeSession, showSelector, wsReady, setMode, setActiveSession, setShowSelector } = useDashboardStore()

  // Compute the WebSocket URL to connect to:
  // - archive + session loaded → replay endpoint
  // - live → live stream endpoint
  // - otherwise → null (no connection)
  const wsUrl = (() => {
    if (mode === 'live') return liveStreamUrl()
    if (mode === 'archive' && activeSession) {
      return archiveReplayUrl(activeSession.year, activeSession.gp, activeSession.sessionType, activeSession.driverA, activeSession.driverB)
    }
    return null
  })()

  useReplaySocket(wsUrl)

  const sessionLabel = activeSession
    ? `${activeSession.year} ${activeSession.gp.toUpperCase()} — ${activeSession.sessionType.toUpperCase()}`
    : mode === 'archive' ? 'SELECT A SESSION'
      : 'NO ACTIVE SESSION'

  const handleModeChange = (m: SessionMode) => {
    setMode(m)
    router.replace(`/dashboard?mode=${m}`)
    if (m === 'archive' && !activeSession) setShowSelector(true)
    if (m === 'live') {
      setActiveSession(null)
      router.replace('/dashboard?mode=live')
    }
  }

  const handleSessionConfirm = (params: SessionParams) => {
    setActiveSession(params)
    setShowSelector(false)
    if (params.driverB) {
      router.push(`/dashboard/compare?year=${params.year}&gp=${encodeURIComponent(params.gp)}&session=${encodeURIComponent(params.sessionType)}&driverA=${params.driverA}&driverB=${params.driverB}`)
    } else {
      router.replace('/dashboard?mode=archive')
    }
  }

  return (
    <div className="flex flex-col h-screen bg-bg-primary overflow-hidden">
      <Suspense fallback={null}>
        <SearchParamsSync />
      </Suspense>
      <DashboardHeader
        mode={mode}
        onModeChange={handleModeChange}
        sessionLabel={sessionLabel}
        isLive={mode === 'live' && wsReady}
      />

      <Suspense fallback={null}>
        {children}
      </Suspense>

      {showSelector && (
        <SessionSelector
          onConfirm={handleSessionConfirm}
          onClose={() => setShowSelector(false)}
        />
      )}
    </div>
  )
}
