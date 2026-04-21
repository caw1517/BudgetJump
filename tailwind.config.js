/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: '#ffffff',
        'surface-muted': '#f8fafc',
        'surface-elevated': '#ffffff',
        'border-subtle': '#e4e7ec',
        'text-muted': '#5f6b7a',
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          600: '#059669',
          700: '#047857',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.05), 0 10px 24px rgba(15, 23, 42, 0.06)',
      },
      borderRadius: {
        xl2: '1rem',
      },
    },
  },
  plugins: [],
}
