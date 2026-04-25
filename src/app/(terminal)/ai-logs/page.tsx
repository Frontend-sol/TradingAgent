import { AiDecisionLogTable } from "@/components/tables/ai-decision-log-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AiLogsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI 决策日志</CardTitle>
      </CardHeader>
      <CardContent>
        <AiDecisionLogTable />
      </CardContent>
    </Card>
  );
}
