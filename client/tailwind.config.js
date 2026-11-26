/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#FDF8F3',
          100: '#F9ECE0',
          200: '#F2D5BC',
          300: '#E7B68E',
          400: '#D9935B',
          500: '#B47B38',
          600: '#9A6529',
          700: '#7D4E22',
          800: '#653F1F',
          900: '#52341C',
        },
        surface: {
          DEFAULT: '#F8F7F4',
          card: '#FFFFFF',
          sidebar: '#1C1917',
          sidebarHover: '#292524',
        },
      },
      fontFamily: {
        sans: ['"Inter"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
