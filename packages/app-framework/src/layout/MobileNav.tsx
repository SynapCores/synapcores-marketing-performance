'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { Button } from '../ui/button';
import { SidebarNav, type SidebarSection } from './Sidebar';

export const MOBILE_NAV_ID = 'framework-mobile-nav';

/**
 * Hamburger button + slide-in drawer with the same links as the desktop
 * sidebar. Only rendered below the `md` breakpoint (the sidebar is
 * `hidden md:flex`), so desktop layout is unaffected.
 *
 * Radix Dialog gives us the accessibility behaviour: aria-expanded /
 * aria-controls on the trigger, focus trapped inside the drawer, Escape
 * and backdrop tap close it, focus returns to the button on close.
 *
 * Height: `h-dvh` / `max-h-dvh` size the drawer to the *visible* viewport.
 * `inset-y-0` alone takes the height of the fixed containing block, which
 * mobile browsers can make taller than what is visible (iOS Safari's bottom
 * toolbar, Android's URL bar), so the last links sat under the toolbar and
 * the list was too short to scroll them up. With an explicit height the
 * `bottom-0` from `inset-y-0` is ignored; it stays as the fallback for
 * browsers without dvh units. The link list scrolls inside the drawer
 * (`min-h-0` + `overscroll-contain`) and its bottom padding clears the home
 * indicator. Tap targets are 44px on mobile.
 */
export function MobileNav({
  sections,
  brand,
}: {
  sections: SidebarSection[];
  brand: { label: string; href: string };
}) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);

  // Also close when the route changes by any other means (back button, etc.).
  const pathname = usePathname();
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex items-center gap-1 md:hidden">
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 h-11 w-11 hover:bg-accent"
            aria-label="Open navigation menu"
            aria-controls={MOBILE_NAV_ID}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            data-testid="mobile-nav-backdrop"
            className="fixed inset-0 z-50 bg-black/60 md:hidden"
          />
          <DialogPrimitive.Content
            id={MOBILE_NAV_ID}
            className="fixed inset-y-0 left-0 z-50 flex h-dvh max-h-dvh w-72 max-w-[85vw] flex-col border-r border-border bg-card text-foreground shadow-lg focus:outline-none md:hidden"
          >
            <div className="h-14 flex items-center justify-between gap-2 pl-5 pr-2 border-b border-border">
              <DialogPrimitive.Title asChild>
                <Link
                  prefetch={false}
                  href={brand.href}
                  onClick={close}
                  className="font-headline text-lg font-bold tracking-tight text-foreground truncate"
                >
                  {brand.label}
                </Link>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 hover:bg-accent"
                  aria-label="Close navigation menu"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </Button>
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="sr-only">
              Site navigation
            </DialogPrimitive.Description>
            <SidebarNav
              sections={sections}
              onNavigate={close}
              ariaLabel="Mobile"
              className="min-h-0 overscroll-contain pb-[max(1rem,env(safe-area-inset-bottom))]"
              itemClassName="py-3"
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <Link
        prefetch={false}
        href={brand.href}
        className="font-headline text-base font-bold tracking-tight text-foreground truncate max-w-[55vw]"
      >
        {brand.label}
      </Link>
    </div>
  );
}
