// Owner: B (Frontend)
// Purpose: top navigation

import { useAuth } from '../../hooks/useAuth';
import { isMockMode } from '../../services/apiClient';

interface NavbarProps {
  onToggleSidebar: () => void;
}

function formatRole(role: string): string {
  return role.replace(/_/g, ' ');
}

export function Navbar({ onToggleSidebar }: NavbarProps) {
  const { user, logout } = useAuth();

  // ProtectedRoute sends the user to /login once the session is cleared.
  async function handleSignOut() {
    await logout();
  }

  return (
    <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="rounded-md p-2 text-slate-600 hover:bg-slate-100 md:hidden"
        aria-label="Toggle navigation"
      >
        ☰
      </button>
      <span className="text-lg font-semibold text-emerald-700">eBioTrack</span>
      {isMockMode() && (
        <span
          className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
          title="VITE_USE_MOCK=true: data comes from src/services/mock, not the backend"
        >
          Mock data
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        {user && (
          <span className="hidden text-right text-sm sm:block">
            <span className="block font-medium text-slate-800">{user.full_name}</span>
            <span className="block text-xs capitalize text-slate-500">
              {user.roles.map(formatRole).join(', ')}
            </span>
          </span>
        )}
        <button
          type="button"
          onClick={handleSignOut}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
