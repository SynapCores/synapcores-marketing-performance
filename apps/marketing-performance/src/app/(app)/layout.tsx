import {
  DashboardLayout,
  FRAMEWORK_SIDEBAR_SECTION,
  SidebarIcons,
} from '@synapcores/app-framework';
import { requireSession } from '@/lib/session';
import { signOut } from '@/lib/auth';

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  const nav = {
    heading: 'Marketing',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: <SidebarIcons.Home className="h-4 w-4" /> },
      { href: '/ingest', label: 'Ingest Data', icon: <SidebarIcons.Activity className="h-4 w-4" /> },
      { href: '/settings/pixels', label: 'Tracking Pixels', icon: <SidebarIcons.FileLock2 className="h-4 w-4" /> },
      { href: '/campaigns', label: 'Campaigns', icon: <SidebarIcons.ShieldAlert className="h-4 w-4" /> },
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
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8">{children}</div>
    </DashboardLayout>
  );
}
