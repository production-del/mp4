import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from './components/ThemeProvider';
import { ThemeToggle } from './components/ThemeToggle';
import { NavLinks } from './components/NavLinks';

export const metadata: Metadata = {
  title: "Byron Planner | Production Planning System",
  description: "Kitchen and purchasing calendar planning system for Byron Co-op",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('byron-theme');if(!t)t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`,
          }}
        />
      </head>
      <body style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
        <ThemeProvider>
          <div className="min-h-screen flex flex-col">
            <header style={{ position: 'sticky', top: 0, zIndex: 40, borderBottom: '0.5px solid var(--border)', background: 'var(--bg-page)' }}>
              {/* Full-width nav bar: no max-width constraint so the tabs can
                  breathe on wide displays. The branding title has been
                  removed per operator request — the tabs are the identity. */}
              <nav className="w-full px-6 py-3 flex items-center justify-between gap-4">
                <NavLinks />
                <ThemeToggle />
              </nav>
            </header>
            <main className="flex-1 w-full">
              {children}
            </main>
            <footer style={{ borderTop: '0.5px solid var(--border)' }}>
              <div className="w-full px-6 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                Byron Co-op Production Planning System · {new Date().getFullYear()}
              </div>
            </footer>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
