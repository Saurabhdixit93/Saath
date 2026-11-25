import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@saath/ui", "@saath/contracts"],
};

export default nextConfig;
