'use client'
const stack = [
  { label: 'FastF1', sub: 'Telemetry' },
  { label: 'OpenF1', sub: 'Live API' },
  { label: 'Redis', sub: 'Pub/Sub' },
  { label: 'WebSockets', sub: 'Stream' },
  { label: 'FastAPI', sub: 'Backend' },
  { label: 'Next.js', sub: 'Frontend' },
  { label: 'Claude API', sub: 'NL Query' },
  { label: 'AWS ECS', sub: 'Deploy' },
  { label: 'Docker', sub: 'Container' },
  { label: 'Python', sub: 'Analysis' },
]

export default function TechStack() {
  return (
    <section className="w-full border-y border-border-dark py-8 overflow-hidden relative">
      <div className="absolute left-0 top-0 h-full w-24 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to right, #080808, transparent)' }}/>
      <div className="absolute right-0 top-0 h-full w-24 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to left, #080808, transparent)' }}/>
      <div className="flex animate-ticker whitespace-nowrap">
        {[...stack, ...stack].map((item, i) => (
          <div key={i} className="inline-flex items-center gap-3 px-8 border-r border-border-dark">
            <span className="font-display text-xs font-semibold text-text-primary tracking-widest uppercase">
              {item.label}
            </span>
            <span className="font-mono text-xs text-text-dim">{item.sub}</span>
          </div>
        ))}
      </div>
    </section>
  )
}