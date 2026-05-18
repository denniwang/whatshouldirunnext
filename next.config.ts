import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    typedRoutes: false,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "dgalywyr863hv.cloudfront.net" },
      { protocol: "https", hostname: "graph.strava.com" },
    ],
  },
};

export default nextConfig;
