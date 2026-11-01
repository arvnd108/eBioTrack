// Owner: B (Frontend)
// Purpose: Route table with protected routes
//
// Everything except /login sits behind <ProtectedRoute> and inside the <App> layout.
// Sidebar links live in navigation.ts; keep the two in step when adding a page (a route with
// `anyOf` here should have the same `anyOf` there).

import { createBrowserRouter, Link, type RouteObject } from 'react-router-dom';
import App from './App';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { ADMIN_ACTIONS, IMPORT_ACTIONS } from './navigation';
import AdministrationPage from './pages/AdministrationPage';
import AnalysisImportPage from './pages/AnalysisImportPage';
import BiodiversityAnalyticsPage from './pages/BiodiversityAnalyticsPage';
import CollectionEventsPage from './pages/CollectionEventsPage';
import DashboardPage from './pages/DashboardPage';
import LabProcessingPage from './pages/LabProcessingPage';
import LoginPage from './pages/LoginPage';
import MlInsightsPage from './pages/MlInsightsPage';
import ProjectsPage from './pages/ProjectsPage';
import SampleDetailPage from './pages/SampleDetailPage';
import SamplesPage from './pages/SamplesPage';
import SamplingMapPage from './pages/SamplingMapPage';
import SpeciesExplorerPage from './pages/SpeciesExplorerPage';

function NotFound() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-slate-600">
        <Link to="/" className="text-emerald-700 underline">
          Back to the dashboard
        </Link>
      </p>
    </section>
  );
}

/** The route table; exported so tests can mount it in a memory router. */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <App />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'map', element: <SamplingMapPage /> },
          { path: 'events', element: <CollectionEventsPage /> },
          { path: 'samples', element: <SamplesPage /> },
          { path: 'samples/:sampleId', element: <SampleDetailPage /> },
          { path: 'lab', element: <LabProcessingPage /> },
          {
            element: <ProtectedRoute anyOf={IMPORT_ACTIONS} />,
            children: [{ path: 'analyses/import', element: <AnalysisImportPage /> }],
          },
          { path: 'species', element: <SpeciesExplorerPage /> },
          { path: 'analytics', element: <BiodiversityAnalyticsPage /> },
          { path: 'ml', element: <MlInsightsPage /> },
          {
            element: <ProtectedRoute anyOf={ADMIN_ACTIONS} />,
            children: [{ path: 'admin', element: <AdministrationPage /> }],
          },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
