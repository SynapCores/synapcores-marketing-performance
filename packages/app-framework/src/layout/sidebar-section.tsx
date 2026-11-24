import * as React from 'react';
import { FileLock2, Settings, Users } from 'lucide-react';
import type { SidebarSection } from './Sidebar';

/**
 * The framework's "general" sidebar items every app shows at the bottom.
 * Apps spread these in alongside their app-specific items.
 *
 * Lives in a plain (non-`'use client'`) module, like icons.ts, so a server
 * component (an app's (app)/layout.tsx) gets the real object. Exported from
 * the 'use client' Sidebar module it was only a client reference on the
 * server: passing it through worked, reading it there would have thrown.
 */
export const FRAMEWORK_SIDEBAR_SECTION: SidebarSection = {
  heading: 'Workspace',
  items: [
    {
      href: '/audit',
      label: 'Audit log',
      icon: <FileLock2 className="h-4 w-4" />,
    },
    {
      href: '/team',
      label: 'Team',
      icon: <Users className="h-4 w-4" />,
    },
    {
      href: '/settings',
      label: 'Settings',
      icon: <Settings className="h-4 w-4" />,
    },
  ],
};
