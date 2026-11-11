import type { NextConfig } from "next";

const cameraPolicy = { key: "Permissions-Policy", value: "camera=(self)" };

const nextConfig: NextConfig = {
  // One self-contained server bundle, so the same Docker image runs on every cloud.
  output: "standalone",
  // Scanning stays on this origin. Embedded frames and other sites cannot open the camera.
  async headers() {
    return [
      { source: "/", headers: [cameraPolicy] },
      { source: "/:path*", headers: [cameraPolicy] },
    ];
  },
  // Cache Components stays off in the template: most apps here read the session on
  // nearly every page, and the classic dynamic model keeps that simple. An app can
  // opt in later if it has mostly public, cacheable pages.
  cacheComponents: false,
  // Keep the Postgres driver out of the bundle; it is loaded at runtime.
  serverExternalPackages: ["postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
