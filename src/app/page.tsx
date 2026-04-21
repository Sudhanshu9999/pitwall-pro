import Link from 'next/link'
import TrackHero from '@/components/landing/TrackHero'
import FeatureCards from '@/components/landing/FeatureCards'
import TechStack from '@/components/landing/TechStack'
import CTASection from '@/components/landing/CTASection'

export default function Home() {
  return (
    <main className="min-h-screen bg-bg-primary">
      <section className="relative min-h-screen flex flex-col overflow-hidden">
        <TrackHero />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.03) 2px,rgba(0,0,0,0.03) 4px)' }}/>

        <nav className="relative z-10 flex items-center justify-between px-6 sm:px-10 py-6 border-b border-border-dark">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 bg-f1-red rounded-full animate-pulse-red"/>
            <span className="font-display text-sm font-bold text-text-primary tracking-widest uppercase">PitWall Pro</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="https://github.com/sudhanshujadhav/pitwall-pro" target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-text-muted hover:text-text-primary transition-colors hidden sm:block">GitHub</a>
            <Link href="/dashboard" className="font-display text-xs font-bold tracking-widest uppercase px-5 py-2.5 border border-f1-red text-f1-red hover:bg-f1-red hover:text-white transition-colors duration-200">
              Dashboard →
            </Link>
          </div>
        </nav>

        <div className="relative z-10 flex-1 flex flex-col items-start justify-center px-6 sm:px-10 lg:px-16 pb-24 pt-16">
          <div className="flex items-center gap-2 mb-8 border border-border-accent px-3 py-1.5 bg-bg-card">
            <span className="w-1.5 h-1.5 rounded-full bg-flag-green"/>
            <span className="font-mono text-xs text-text-muted tracking-widest uppercase">FastF1 · OpenF1 · Real Data</span>
          </div>

          <h1 className="font-display font-black text-4xl sm:text-6xl lg:text-7xl xl:text-8xl text-text-primary uppercase leading-none tracking-tight max-w-4xl">
            <span className="block">Pit Wall</span>
            <span className="block text-f1-red">Pro</span>
          </h1>

          <p className="font-body text-base sm:text-lg text-text-muted mt-6 max-w-xl leading-relaxed">
            Live telemetry. Real tyre degradation models. Undercut probability. Natural language race queries. Every session. Every lap.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 mt-10">
            <Link href="/dashboard" className="inline-flex items-center justify-center gap-3 px-8 py-4 bg-f1-red text-white font-display text-xs font-bold tracking-widest uppercase hover:bg-f1-red-bright transition-colors">
              Open Dashboard
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7h12M8 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </Link>
            <Link href="/dashboard?mode=archive" className="inline-flex items-center justify-center gap-3 px-8 py-4 border border-border-accent text-text-muted font-display text-xs font-bold tracking-widest uppercase hover:border-text-muted hover:text-text-primary transition-colors">
              Browse Archive
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-12">
            {['VER','NOR','LEC','SAI','HAM','RUS','PIA','ALO'].map(code => (
              <span key={code} className="font-mono text-xs px-2.5 py-1 border border-border-dark text-text-dim bg-bg-card hover:border-f1-red hover:text-f1-red transition-colors cursor-default">{code}</span>
            ))}
            <span className="font-mono text-xs text-text-dim">+12 more</span>
          </div>
        </div>

        <div className="relative z-10 flex justify-center pb-8 animate-bounce">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-text-dim">
            <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      </section>

      <TechStack />
      <FeatureCards />
      <CTASection />
    </main>
  )
}