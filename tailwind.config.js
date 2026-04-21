/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx}',
    './src/components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'bg-primary': '#080808',
        'bg-secondary': '#0f0f0f',
        'bg-card': '#111111',
        'bg-card-hover': '#161616',
        'border-dark': '#1e1e1e',
        'border-accent': '#2a2a2a',
        'f1-red': '#e8002d',
        'f1-red-bright': '#ff1744',
        'f1-red-muted': '#3d0010',
        'text-primary': '#f0f0f0',
        'text-muted': '#a0a0a0',
        'text-dim': '#505050',
        'flag-yellow': '#ffd600',
        'flag-green': '#00c853',
        'safety-car': '#ff6d00',
      },
      fontFamily: {
        display: ['Orbitron', 'monospace'],
        body: ['Rajdhani', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'pulse-red': 'pulseRed 2s ease-in-out infinite',
        'ticker': 'ticker 30s linear infinite',
        'blink': 'blink 1s step-end infinite',
        'scan-line': 'scanLine 3s linear infinite',
        'count-up': 'countUp 0.5s ease-out',
        'fade-in-out': 'fadeInOut 4s ease-in-out forwards',
      },
      keyframes: {
        pulseRed: {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 0 0 rgba(232,0,45,0.4)' },
          '50%': { opacity: '0.8', boxShadow: '0 0 0 8px rgba(232,0,45,0)' },
        },
        ticker: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(-100%)' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        scanLine: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
        countUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeInOut: {
          '0%':   { opacity: '0', transform: 'translateY(4px)' },
          '12%':  { opacity: '1', transform: 'translateY(0)' },
          '75%':  { opacity: '1' },
          '100%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [],
}