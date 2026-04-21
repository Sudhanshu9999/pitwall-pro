'use client'
import { useEffect, useRef, useState } from 'react'

const features = [
  { id: '01', title: 'Live Telemetry Stream', desc: 'Speed, throttle, brake, gear and RPM via WebSockets. Canvas-rendered charts that never drop a frame under high-frequency updates.', tag: 'WebSockets · Redis · Canvas', accent: '#e8002d', comingSoon: false },
  { id: '02', title: 'Strategy Intelligence', desc: 'Tyre degradation curves fitted from real lap data. Undercut probability scoring. Pit window analysis — the same logic race engineers use.', tag: 'FastF1 · Regression · Python', accent: '#ff8000', comingSoon: false },
  { id: '03', title: 'Natural Language Query', desc: 'Ask in plain English. "When did Norris close the gap in 2023 Singapore?" Claude converts it to a FastF1 query and renders the chart.', tag: 'Claude API · NLP', accent: '#ffd600', comingSoon: true },
  { id: '04', title: 'Driver vs Driver', desc: 'Side-by-side telemetry overlays, sector delta charts, lap time progression and tyre strategy timelines for any two drivers in any session.', tag: 'Comparison · Delta · Sectors', accent: '#00c853', comingSoon: false },
  { id: '05', title: 'ERS Deployment Estimate', desc: 'No direct ERS data is public. We infer deployment zones from speed-throttle anomalies per corner — and we tell you exactly how we do it.', tag: 'Inference · Physics Model', accent: '#00bcd4', comingSoon: false },
  { id: '06', title: 'Archive 2018–2024', desc: 'Every session. Every lap. Every corner. Replay any race from six seasons as a live stream at 1x, 2x or 10x speed.', tag: 'FastF1 · Redis Pub/Sub', accent: '#9c27b0', comingSoon: false },
]

function Card({ f, index }: { f: typeof features[0]; index: number }) {
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true) }, { threshold: 0.15 })
    if (ref.current) obs.observe(ref.current)
    return () => obs.disconnect()
  }, [])
  return (
    <div ref={ref} style={{ transitionDelay: `${index * 80}ms`, borderTop: `1px solid ${f.accent}40` }}
      className={`relative p-6 bg-bg-card border border-border-dark transition-all duration-700 group cursor-default hover:bg-bg-card-hover ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}>
      <div className="absolute top-0 left-0 h-px w-0 group-hover:w-full transition-all duration-500" style={{ background: f.accent }}/>
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-xs" style={{ color: f.accent }}>{f.id}</span>
        {f.comingSoon && (
          <span className="font-mono text-[9px] tracking-widest uppercase px-2 py-0.5 border border-text-dim/40 text-text-dim">
            Coming Soon
          </span>
        )}
      </div>
      <h3 className="font-display text-xs font-semibold text-text-primary mb-3 tracking-wider uppercase">{f.title}</h3>
      <p className="font-body text-sm text-text-muted leading-relaxed mb-4">{f.desc}</p>
      <span className="font-mono text-xs text-text-dim">{f.tag}</span>
    </div>
  )
}

export default function FeatureCards() {
  return (
    <section className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
      <div className="mb-16">
        <span className="font-mono text-xs text-f1-red tracking-widest uppercase">Capabilities</span>
        <h2 className="font-display text-2xl sm:text-3xl font-bold text-text-primary mt-3 tracking-wide uppercase">Built for the pit wall</h2>
        <div className="w-16 h-px bg-f1-red mt-4"/>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border-dark">
        {features.map((f, i) => <Card key={f.id} f={f} index={i}/>)}
      </div>
    </section>
  )
}