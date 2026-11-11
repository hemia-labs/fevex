import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: '/slack', destination: '/?agent=slack-support', permanent: false }];
  },
};

export default nextConfig;
