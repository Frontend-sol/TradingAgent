import { TradingViewLogTable } from "@/components/tables/tradingview-log-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function TradingViewLogsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>TV Webhook 日志</CardTitle>
      </CardHeader>
      <CardContent>
        <TradingViewLogTable />
      </CardContent>
    </Card>
  );
}
