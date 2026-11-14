import { AssistantChat } from '@/components/assistant/chat';
import { useAssistant } from '@/components/assistant/assistant-context';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@clickland/ui';
import { Plus } from 'lucide-react';

/** The assistant as a full page (the phone's way in; on desktop the side card is the usual one). */
export function AssistantPage() {
  const { reset } = useAssistant();
  return (
    <>
      <PageHeader
        title="Assistant"
        actions={
          <Button size="sm" variant="ghost" onClick={reset}>
            <Plus className="size-3.5" /> New chat
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-3xl">
        <AssistantChat variant="page" />
      </div>
    </>
  );
}
