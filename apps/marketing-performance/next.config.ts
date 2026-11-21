import type { NextConfig } from 'next';
import path from 'node:path';

const isProd = process.env.NODE_ENV === 'production';

// App Router streams inline bootstrap scripts, so script-src needs
// 'unsafe-inline' unless we move to per-request nonces; everything else is
// locked to same-origin. 'unsafe-eval' is only allowed in dev (React refresh).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

const baseHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle for deployment (node .next/standalone/.../server.js).
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  poweredByHeader: false,
  transpilePackages: ['@synapcores/app-framework'],
  typedRoutes: false,
  async headers() {
    return [
      // Everything: strict headers, not embeddable, no caching of app pages.
      { source: '/:path*', headers: [...baseHeaders, { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' }] },
      // The pixel script is loaded cross-site by the tracked domains.
      {
        source: '/track.js',
        headers: [
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      // The collector is called cross-site by the beacon (CORS handled in the route).
      { source: '/api/v1/collect', headers: [{ key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }] },
    ];
  },
};

export default nextConfig;
