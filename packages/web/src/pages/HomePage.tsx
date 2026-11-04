import { useTitle } from '@/lib/use-title';
import { AuditAssistant } from '@/components/AuditAssistant';

/** The first page: describe an audit, centred like a chat. */
export function HomePage() {
  useTitle('Set up an audit');
  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-2xl flex-col justify-center py-8">
      <AuditAssistant />
    </div>
  );
}
