import { Link } from 'react-router';
import { EmptyState } from '@clickland/ui';
import { PageHeader } from '@/components/shell/page-header';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState title="There’s no page here" action={<Link to="/search" className="text-ac hover:underline">Go to Search</Link>} />
    </>
  );
}
