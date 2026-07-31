import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta §8. Los primitivos de shadcn heredan de estas variables
        // (definidas en globals.css) en vez del tema por defecto.
        ink: {
          950: '#0A0A0A',
          900: '#121212',
          800: '#181818',
        },
        line: 'rgba(255,255,255,0.08)',
        fg: {
          DEFAULT: '#EDEDED',
          muted: '#A3A3A3',
          faint: '#6B6B6B',
        },
        accent: {
          from: '#FF6B35',
          to: '#D62828',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        // Radio máximo 4 px, o cero.
        lg: '4px',
        md: '4px',
        sm: '2px',
      },
      fontFamily: {
        sans: ['var(--font-grotesk)', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        micro: '0.2em',
        tightest: '-0.03em',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'bar-pulse': {
          '0%, 100%': { opacity: '0.22' },
          '50%': { opacity: '0.6' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'bar-pulse': 'bar-pulse 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
};

export default config;
