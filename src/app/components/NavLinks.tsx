'use client';

import { usePathname } from 'next/navigation';

const links = [
  { href: '/calendar', label: 'Calendar' },
  { href: '/packaging', label: 'Packaging' },
  { href: '/kitchen', label: 'Kitchen' },
  { href: '/purchasing', label: 'Component' },
  { href: '/purchase-orders', label: 'Purchases' },
  { href: '/logistics', label: 'Logistics' },
  { href: '/transfers', label: 'Transfers' },
  { href: '/priorities', label: 'Priorities' },
  { href: '/review', label: 'Drafts' },
  { href: '/assemblies', label: 'Assemblies' },
  { href: '/products', label: 'Products' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/settings', label: 'Settings' },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="flex gap-3 flex-wrap items-center">
      {links.map((link) => {
        const isActive = pathname === link.href || pathname.startsWith(link.href + '/');
        return (
          <li key={link.href}>
            <a
              href={link.href}
              className="no-underline transition px-4 py-2 rounded"
              style={{
                fontSize: '0.9375rem',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                fontWeight: isActive ? 500 : 400,
                background: isActive ? 'var(--accent-light)' : 'var(--bg-surface)',
                border: `0.5px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {link.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
