import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  transpilePackages: ["@dispatchlab/core"],
  images: { unoptimized: true },
};
export default config;
