import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  reactStrictMode: true,
};
export default config;
