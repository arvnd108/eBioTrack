// Owner: B (Frontend)
// Purpose: section navigation by role

import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { navItems } from '../../navigation';

interface SidebarProps {
  open: boolean;
  onNavigate: () => void;
}

export function Sidebar({ open, onNavigate }: SidebarProps) {
  const { canAny } = useAuth();
  // Hide pages the user's role cannot use (same rule as ProtectedRoute in routes.tsx).
  const items = navItems.filter((item) => !item.anyOf || canAny(item.anyOf));

  return (
    <nav
      id="main-navigation"
      aria-label="Main"
      className={`${open ? 'block' : 'hidden'} w-full border-b border-slate-200 bg-white md:block md:w-60 md:shrink-0 md:border-b-0 md:border-r`}
    >
      <ul className="space-y-1 p-3">
        {items.map((item) => (
          <li key={item.path}>
            <NavLink
              to={item.path}
              end={item.path === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-emerald-50 font-medium text-emerald-800'
                    : 'text-slate-700 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
