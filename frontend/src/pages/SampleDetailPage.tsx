// Owner: B (Frontend)
// Purpose: Sample detail and status timeline

import { useParams } from 'react-router-dom';
import { PagePlaceholder } from '../components/layout/PagePlaceholder';

export default function SampleDetailPage() {
  const { sampleId } = useParams();
  return (
    <PagePlaceholder
      title={`Sample ${sampleId ?? ''}`}
      task="T26"
      description="Sample detail with event, site, extractions, and status timeline."
    />
  );
}
