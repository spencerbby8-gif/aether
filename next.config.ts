import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      /* Contract paths for the server-side wake/off functions. */
      {
        source: "/.netlify/functions/ensure-alive",
        destination: "/api/netlify/ensure-alive",
      },
      {
        source: "/.netlify/functions/engine-off",
        destination: "/api/netlify/engine-off",
      },
    ];
  },
};

export default nextConfig;
