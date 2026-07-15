/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'root-glow': '0 0 0 1px rgba(251, 191, 36, 0.45), 0 0 20px rgba(251, 191, 36, 0.15)',
      },
    },
  },
  plugins: [],
};
