import type { Metadata, Viewport } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

// Grotesca de titulares (pesos 700–800) y monoespaciada para micro-etiquetas.
const grotesk = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '700', '800'],
  variable: '--font-grotesk',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'TRANSCRIPTOR — audio a texto en español',
  description:
    'Transcripción de audio a texto en español, sin límite de duración. Salida cruda, editada y resumida.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0A0A0A',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="es" className={`${grotesk.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-ink-950 text-fg">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
