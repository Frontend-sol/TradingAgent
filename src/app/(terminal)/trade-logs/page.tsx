import { TradeLogTable } from "@/components/tables/trade-log-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function TradeLogsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>交易日志</CardTitle>
      </CardHeader>
      <CardContent>
        <TradeLogTable />
      </CardContent>
    </Card>
  );
}
