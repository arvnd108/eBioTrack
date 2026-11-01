// Owner: B (Frontend)
// Purpose: App shell and layout
//
// Signed-in layout: Navbar on top, Sidebar on the left (collapses on small screens), and the
// current page in <main> (pages load on demand, so a loading state shows while one arrives).
// Routes are defined in routes.tsx.

import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { LoadingState } from './components/common/LoadingState';
import { Navbar } from './components/layout/Navbar';
import { Sidebar } from './components/layout/Sidebar';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to main content
      </a>
      <Navbar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      <div className="flex flex-1 flex-col md:flex-row">
        <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 md:p-8">
          {/* Pages are loaded on demand (routes.tsx). */}
          <Suspense fallback={<LoadingState label="Loading page…" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
