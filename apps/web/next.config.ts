import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
// Environment lives in the repo root (.env.local), shared by all apps and packages.
config({ path: [path.join(here, "../../.env.local"), path.join(here, "../../.env")], quiet: true });

const nextConfig: NextConfig = {
  transpilePackages: ["@beam/db"],
  serverExternalPackages: ["pg"],
  outputFileTracingRoot: path.join(here, "../.."),
};

export default nextConfig;
