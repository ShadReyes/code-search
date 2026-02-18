import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.example.com' },
      { protocol: 'https', hostname: 'cdn.images.io' },
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
    typedRoutes: true,
  },
  async redirects() {
    return [
      {
        source: '/old-blog/:slug',
        destination: '/blog/:slug',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
