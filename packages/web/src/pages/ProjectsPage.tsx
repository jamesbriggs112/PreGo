import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, type ProjectListItem, type RunSummary } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { useTitle } from '@/lib/use-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RunStatusBadge } from '@/components/RunStatusBadge';
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog';

export function ProjectsPage() {
  useTitle('Projects');
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null);
  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: () => {
      setName('');
      return queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground">Clients and sites you audit, with their latest results.</p>
        </div>
        <Button asChild>
          <Link to="/audits/new">
            <Plus aria-hidden="true" /> New audit
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All projects</CardTitle>
          <CardDescription>Accessibility scores show where to focus, not a measure of compliance.</CardDescription>
        </CardHeader>
        <CardContent>
          {projects.isPending && <p>Loading projects…</p>}
          {projects.isError && (
            <Alert variant="destructive" role="alert">
              Couldn’t load projects: {projects.error.message}
            </Alert>
          )}
          {projects.data?.length === 0 && <p className="text-muted-foreground">No projects yet. Create one below, or start a new audit.</p>}
          {projects.data && projects.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Project</TableHead>
                  <TableHead scope="col">Last audit</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Accessibility score</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.data.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">{project.name}</TableCell>
                    <TableCell>{project.lastRun ? formatDateTime(project.lastRun.startedAt) : 'Never audited'}</TableCell>
                    <TableCell>{project.lastRun ? <RunStatusBadge status={project.lastRun.status} /> : '–'}</TableCell>
                    <TableCell>{project.scores?.A11Y ?? '–'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {project.lastRun && <LastRunLink run={project.lastRun} projectName={project.name} />}
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/projects/${project.id}/audience`} aria-label={`Purposes and audience of ${project.name}`}>
                            Audience
                          </Link>
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/audits/new?project=${encodeURIComponent(project.name)}`} aria-label={`New audit of ${project.name}`}>
                            New audit
                          </Link>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(project)} aria-label={`Delete ${project.name}`}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a project</CardTitle>
          <CardDescription>A project is a client or a site. Each keeps its own ticket numbers across audits.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
            <div className="grid w-full max-w-sm gap-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Museum of Making" required />
            </div>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Adding…' : 'Add project'}
            </Button>
          </form>
          {create.isError && (
            <Alert variant="destructive" role="alert" className="mt-3">
              {create.error.message}
            </Alert>
          )}
        </CardContent>
      </Card>

      {deleting && <DeleteProjectDialog project={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function LastRunLink({ run, projectName }: { run: RunSummary; projectName: string }) {
  const label = run.status === 'running' ? 'Watch live' : 'View results';
  return (
    <Button asChild size="sm" variant="secondary">
      <Link to={`/runs/${run.id}`} aria-label={`${label}: ${projectName}`}>
        {label}
      </Link>
    </Button>
  );
}
