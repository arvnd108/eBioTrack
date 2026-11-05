// Owner: B (Frontend)
// Purpose: Route table with protected routes
//
// Everything except /login sits behind <ProtectedRoute> and inside the <App> layout.
// Sidebar links live in navigation.ts; keep the two in step when adding a page (a route with
// `anyOf` here should have the same `anyOf` there).

import { lazy } from 'react';
import { createBrowserRouter, Link, type RouteObject } from 'react-router-dom';
import App from './App';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { ADMIN_ACTIONS, IMPORT_ACTIONS } from './navigation';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';

// Each signed-in page is its own chunk, loaded when first opened (App shows a loading state), so
// the first download stays small as pages are added. The login page is in the main bundle.
const AdministrationPage = lazy(() => import('./pages/AdministrationPage'));
const AnalysisImportPage = lazy(() => import('./pages/AnalysisImportPage'));
const BiodiversityAnalyticsPage = lazy(() => import('./pages/BiodiversityAnalyticsPage'));
const CollectionEventsPage = lazy(() => import('./pages/CollectionEventsPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const EventDetailPage = lazy(() => import('./pages/EventDetailPage'));
const LabProcessingPage = lazy(() => import('./pages/LabProcessingPage'));
const MlInsightsPage = lazy(() => import('./pages/MlInsightsPage'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const RunDetailPage = lazy(() => import('./pages/RunDetailPage'));
const SampleDetailPage = lazy(() => import('./pages/SampleDetailPage'));
const SamplesPage = lazy(() => import('./pages/SamplesPage'));
const SamplingMapPage = lazy(() => import('./pages/SamplingMapPage'));
const SpeciesExplorerPage = lazy(() => import('./pages/SpeciesExplorerPage'));

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
  { path: '/register', element: <RegisterPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <App />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:projectId', element: <ProjectDetailPage /> },
          { path: 'map', element: <SamplingMapPage /> },
          { path: 'events', element: <CollectionEventsPage /> },
          { path: 'events/:eventId', element: <EventDetailPage /> },
          { path: 'samples', element: <SamplesPage /> },
          { path: 'samples/:sampleId', element: <SampleDetailPage /> },
          { path: 'lab', element: <LabProcessingPage /> },
          { path: 'lab/runs/:runId', element: <RunDetailPage /> },
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
