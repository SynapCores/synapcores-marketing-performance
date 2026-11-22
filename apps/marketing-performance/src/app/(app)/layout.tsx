import {
  DashboardLayout,
  FRAMEWORK_SIDEBAR_SECTION,
  SidebarIcons,
} from '@synapcores/app-framework';
import { Download, Link2, Megaphone, Users } from 'lucide-react';
import { requireSession } from '@/lib/session';
import { signOut } from '@/lib/auth';
import { TimeZonePicker } from '@/components/TimeZonePicker';

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  // Installs feed: only the workspace the feed belongs to (see lib/installs-store.ts).
  const installsTenant = process.env.INSTALLS_FEED_DIR?.trim() ? process.env.INSTALLS_FEED_TENANT_ID?.trim() : undefined;
  const showInstalls = !!installsTenant && installsTenant === session.tenant?.id;

  const nav = {
    heading: 'Marketing',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: <SidebarIcons.Home className="h-4 w-4" /> },
      { href: '/visitors', label: 'Visitors', icon: <Users className="h-4 w-4" /> },
      ...(showInstalls ? [{ href: '/installs', label: 'Installs', icon: <Download className="h-4 w-4" /> }] : []),
      { href: '/utm-campaigns', label: 'UTM Campaigns', icon: <Megaphone className="h-4 w-4" /> },
      { href: '/utm-campaigns/builder', label: 'Campaign Links', icon: <Link2 className="h-4 w-4" /> },
      { href: '/ingest', label: 'Ingest Data', icon: <SidebarIcons.Activity className="h-4 w-4" /> },
      { href: '/settings/pixels', label: 'Tracking Pixels', icon: <SidebarIcons.FileLock2 className="h-4 w-4" /> },
      { href: '/campaigns', label: 'Ad Campaigns', icon: <SidebarIcons.ShieldAlert className="h-4 w-4" /> },
      { href: '/attribution', label: 'Attribution', icon: <SidebarIcons.FileLock2 className="h-4 w-4" /> },
      { href: '/creative', label: 'Creative', icon: <SidebarIcons.Activity className="h-4 w-4" /> },
      { href: '/recommendations', label: 'AI Recommendations', icon: <SidebarIcons.ShieldAlert className="h-4 w-4" /> },
      { href: '/tables', label: 'Data Tables', icon: <SidebarIcons.FileLock2 className="h-4 w-4" /> },
    ],
  };

  async function doSignOut(): Promise<void> {
    'use server';
    await signOut({ redirectTo: '/login' });
  }

  return (
    <DashboardLayout
      brand={{ label: 'Performance Marketing', href: '/dashboard' }}
      sidebar={[nav, FRAMEWORK_SIDEBAR_SECTION]}
      session={{
        user: { name: session.user.name, email: session.user.email },
        tenant: session.tenant ? { name: session.tenant.name } : null,
      }}
      signOutAction={doSignOut}
    >
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8">
        <div className="mb-3 flex justify-end">
          <TimeZonePicker />
        </div>
        {children}
        <footer className="mt-10 border-t border-border pt-4 text-[11px] text-muted-foreground">
          IP geolocation and network data by{' '}
          <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">DB-IP</a>
          {' '}— IP to City Lite and IP to ASN Lite, licensed{' '}
          <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" className="underline">CC BY 4.0</a>.
        </footer>
      </div>
    </DashboardLayout>
  );
}
