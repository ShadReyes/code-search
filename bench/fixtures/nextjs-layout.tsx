import React from 'react';

export const metadata = {
  title: 'My Application',
  description: 'A modern full-stack application built with Next.js',
  viewport: 'width=device-width, initial-scale=1',
};

interface RootLayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        <nav className="main-nav">
          <a href="/" className="nav-logo">
            MyApp
          </a>
          <div className="nav-links">
            <a href="/dashboard">Dashboard</a>
            <a href="/settings">Settings</a>
          </div>
        </nav>
        <div className="content-wrapper">{children}</div>
        <footer className="main-footer">
          <p>&copy; 2026 MyApp. All rights reserved.</p>
        </footer>
      </body>
    </html>
  );
}
