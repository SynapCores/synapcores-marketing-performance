import { AppPageHeader } from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { filterOptions, listCampaigns } from '@/lib/event-store';
import { canWrite } from '@/lib/security';
import BuilderPanel from './BuilderPanel';

export const dynamic = 'force-dynamic';

export default async function CampaignBuilderPage() {
  const session = await requireSession();
  const tenantId = session.tenant?.id;
  if (!tenantId) return <AppPageHeader title="Campaign link builder" description="Join or create a workspace first." />;
  const [campaigns, opts] = await Promise.all([listCampaigns(tenantId), filterOptions(tenantId)]);
  return (
    <div className="space-y-6">
      <AppPageHeader
        title="Campaign link builder"
        back={{ href: '/utm-campaigns', label: 'UTM Campaigns' }}
        description="Build a UTM-tagged link, save it as a campaign, and copy it into your video description, post or email. Its visits show up under UTM Campaigns."
      />
      <BuilderPanel campaigns={campaigns} sites={opts.sites} canEdit={canWrite(session)} />
    </div>
  );
}
