import { Link } from 'react-router';
import { useTitle } from '@/lib/use-title';

export function NotFoundPage() {
  useTitle('Page not found');
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p>
        <Link to="/" className="text-primary underline">
          Go to the dashboard
        </Link>
      </p>
    </div>
  );
}
