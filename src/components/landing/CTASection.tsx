'use client'
import Link from 'next/link'

export default function CTASection() {
  return (
    <section className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
      <div className="relative border border-border-dark bg-bg-card overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(rgba(232,0,45,0.5) 1px,transparent 1px),linear-gradient(90deg,rgba(232,0,45,0.5) 1px,transparent 1px)', backgroundSize: '40px 40px' }}/>
        <div className="absolute top-0 left-0 w-32 h-px bg-f1-red"/><div className="absolute top-0 left-0 w-px h-32 bg-f1-red"/>
        <div className="absolute bottom-0 right-0 w-32 h-px bg-f1-red"/><div className="absolute bottom-0 right-0 w-px h-32 bg-f1-red"/>
        <div className="relative z-10 flex flex-col lg:flex-row items-center justify-between gap-8 p-10 sm:p-16">
          <div>
            <span className="font-mono text-xs text-f1-red tracking-widest uppercase">Ready</span>
            <h2 className="font-display text-2xl sm:text-4xl font-bold text-text-primary mt-3 uppercase tracking-wide max-w-lg">Enter the pit wall</h2>
            <p className="font-body text-text-muted mt-4 max-w-md text-sm leading-relaxed">Real telemetry. Real lap times. Real tyre compounds. Every session from 2018 to 2024 — replayed live.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-4 shrink-0">
            <Link href="/dashboard" className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-f1-red text-white font-display text-xs font-bold tracking-widest uppercase hover:bg-f1-red-bright transition-colors">
              Open Dashboard
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M8 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </Link>
            <a href="https://github.com/Sudhanshu9999/pitwall-pro" target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-2 px-8 py-4 border border-border-accent text-text-muted font-display text-xs font-bold tracking-widest uppercase hover:border-f1-red hover:text-text-primary transition-colors">
              GitHub
            </a>
          </div>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-8 pt-8 border-t border-border-dark">
        <span className="font-mono text-xs text-text-dim">Built by Sudhanshu Jadhav · 2025</span>
        <span className="font-mono text-xs text-text-dim">Data: FastF1 · OpenF1 · Not affiliated with Formula 1</span>
      </div>
    </section>
  )
}