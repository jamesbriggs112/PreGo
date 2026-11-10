import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ProjectListItem } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Confirms, then permanently deletes a project with everything it holds. `onDeleted` runs after it's gone. */
export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: ProjectListItem; onClose: () => void; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
      onDeleted?.();
    },
  });
  const audits = project.runCount === 1 ? '1 audit' : `${project.runCount} audits`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {project.name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the project and its {audits}, with their screenshots, exports, recorded journeys and saved login. It can’t be undone.
          </DialogDescription>
        </DialogHeader>
        {remove.isError && (
          <Alert variant="destructive" role="alert">
            {remove.error.message}
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
