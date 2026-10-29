// Owner: B (Frontend)
// Purpose: App shell and layout
//
// Signed-in layout: Navbar on top, Sidebar on the left (collapses on small screens), and the
// current page in <main>. Routes are defined in routes.tsx.

import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Navbar } from './components/layout/Navbar';
import { Sidebar } from './components/layout/Sidebar';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-full flex-col">
      <Navbar onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      <div className="flex flex-1 flex-col md:flex-row">
        <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
