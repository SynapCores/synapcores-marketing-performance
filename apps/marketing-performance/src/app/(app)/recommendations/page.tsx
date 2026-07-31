import { AppPageHeader, Card, CardContent, CardHeader, CardTitle, CardDescription } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { RecommendPanel } from './RecommendPanel';

export const dynamic = 'force-dynamic';

export default async function RecommendationsPage() {
  await requireSession();
  return (
    <div className="space-y-6">
      <AppPageHeader title="AI Recommendations" description="Everything else is a report. This turns it into a decision — in one SQL call, no export, no notebook." />
      <Card>
        <CardHeader><CardTitle>Budget reallocation</CardTitle>
          <CardDescription>AGENT_RUN reads recipe_pm_campaign_scorecard with its own execute_query tool and recommends the one campaign to cut and the one to scale — justified by LTV ROAS and contribution margin, not day-0 ROAS.</CardDescription></CardHeader>
        <CardContent><RecommendPanel /></CardContent>
      </Card>
    </div>
  );
}
