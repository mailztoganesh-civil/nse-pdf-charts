import { useListJobs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Download, Loader2, AlertCircle } from "lucide-react";
import type { Job } from "@workspace/api-client-react/src/generated/api.schemas";

export default function Jobs() {
  const { data: jobs, isLoading, isError } = useListJobs({
    query: {
      refetchInterval: 5000 // refresh every 5s to catch job updates
    }
  });

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-12 text-center text-destructive">
        <AlertCircle className="w-8 h-8 mx-auto mb-4" />
        <h3 className="font-mono font-bold">Failed to load jobs</h3>
      </div>
    );
  }

  const getStatusBadge = (status: Job['status']) => {
    switch(status) {
      case 'completed': return <Badge variant="default" className="bg-green-500/20 text-green-500 hover:bg-green-500/30 border-none rounded-sm">COMPLETED</Badge>;
      case 'failed': return <Badge variant="destructive" className="bg-destructive/20 text-destructive hover:bg-destructive/30 border-none rounded-sm">FAILED</Badge>;
      case 'running': return <Badge variant="secondary" className="bg-primary/20 text-primary border-none rounded-sm animate-pulse">RUNNING</Badge>;
      case 'pending': return <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-sm">PENDING</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-mono font-bold tracking-tight">Jobs History</h1>
        <p className="text-muted-foreground mt-2 font-mono text-sm">Past generations and chart book downloads.</p>
      </div>

      <Card className="border-border bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="font-mono font-bold">JOB ID</TableHead>
              <TableHead className="font-mono font-bold">TYPE</TableHead>
              <TableHead className="font-mono font-bold">STATUS</TableHead>
              <TableHead className="font-mono font-bold text-right">STOCKS</TableHead>
              <TableHead className="font-mono font-bold">CREATED</TableHead>
              <TableHead className="font-mono font-bold text-right">ACTIONS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono text-sm">
            {jobs?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No jobs found.
                </TableCell>
              </TableRow>
            ) : jobs?.map((job) => (
              <TableRow key={job.jobId} className="border-border hover:bg-muted/10">
                <TableCell className="font-medium">{job.jobId.slice(0, 8)}...</TableCell>
                <TableCell className="uppercase">{job.type === 'all-nse' ? 'All NSE' : 'CSV Upload'}</TableCell>
                <TableCell>{getStatusBadge(job.status)}</TableCell>
                <TableCell className="text-right">
                  {job.status === 'completed' ? job.stockCount || job.total : '-'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {format(new Date(job.createdAt), "MMM d, HH:mm")}
                </TableCell>
                <TableCell className="text-right">
                  {job.status === 'completed' && (
                    <Button variant="ghost" size="sm" asChild className="h-8 text-primary hover:text-primary hover:bg-primary/10">
                      <a href={`/api/jobs/${job.jobId}/download`} download data-testid={`link-download-${job.jobId}`}>
                        <Download className="w-4 h-4 mr-2" />
                        PDF
                      </a>
                    </Button>
                  )}
                  {job.status === 'failed' && (
                    <span className="text-xs text-destructive truncate max-w-[150px] inline-block" title={job.message}>
                      {job.message}
                    </span>
                  )}
                  {(job.status === 'running' || job.status === 'pending') && (
                    <span className="text-xs text-muted-foreground">
                      {job.progress} / {job.total || '?'}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
