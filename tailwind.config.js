/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', '"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      colors: {
        // Panel surfaces. See index.css for the light model these encode.
        gear: {
          void: 'var(--gear-void)',
          chassis: 'var(--gear-chassis)',
          panel: 'var(--gear-panel)',
          recess: 'var(--gear-recess)',
          engrave: 'var(--gear-engrave)',
          legend: 'var(--gear-legend)',
          text: 'var(--gear-text)',
          accent: 'var(--gear-accent)',
        },
        led: {
          live: 'var(--led-live)',
          hold: 'var(--led-hold)',
          fault: 'var(--led-fault)',
          data: 'var(--led-data)',
        },
      },
      boxShadow: {
        raised: 'var(--bevel-raised)',
        proud: 'var(--bevel-proud)',
        inset: 'var(--bevel-inset)',
        hairline: 'var(--bevel-hairline)',
      },
    },
  },
  plugins: [],
};
