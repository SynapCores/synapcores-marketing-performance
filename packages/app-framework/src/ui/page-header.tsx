import * as React from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { cn } from './cn';

/**
 * The standard in-app page header. Every framework + app page wraps
 * its content with this so titles/spacing stay consistent.
 */
export function AppPageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  title: string;
  /**
   * Breadcrumb-style link to the parent list, shown above the title.
   * Use it on detail pages so they're never a dead end (esp. on mobile).
   */
  back?: { href: string; label: string };
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-4 mb-6',
        className,
      )}
    >
      <div>
        {back && (
          <nav aria-label="Breadcrumb" className="mb-1">
            <Link
              prefetch={false}
              href={back.href}
              className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              {back.label}
            </Link>
          </nav>
        )}
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
