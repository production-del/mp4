import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  pageExtensions: ["ts", "tsx", "js", "jsx"],

  /**
   * Bundle the data/ directory into the serverless function output so
   * files like the capacity spreadsheet, demand.csv, the JSON caches and
   * lead-times config are available at runtime on Vercel. They're read
   * via fs.readFileSync(cwd + "/data/...") on the server, which Next's
   * static analysis can't trace; this list makes the bundling explicit.
   *
   * Keys are page route matchers; values are globs relative to project
   * root. Both the calendar's server component and any /api route that
   * touches the cache files need the include.
   *
   * Note for Vercel: writes to these paths fail at runtime (serverless
   * filesystem is read-only). The READ side works because the files are
   * part of the deployment artifact. Refresh routes that write back to
   * disk are a separate concern (move to a managed store to make them
   * functional in production).
   */
  outputFileTracingIncludes: {
    "/calendar": ["./data/**/*"],
    "/api/**/*": ["./data/**/*"],
  },
};

export default nextConfig;
