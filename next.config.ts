import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/**
 * What a page may load and talk to: itself, and nothing else. Every script, style and font is served by
 * this app; every fetch goes to its own /api; the only images from elsewhere are the small embedded
 * (data:) icons browser wallets announce themselves with. So a script that got into the page could not
 * load code from another site or send anything to one. Inline scripts and styles stay allowed: Next.js
 * boots the page with them and the gauges position themselves with style attributes. Development also
 * needs eval (React's debugging) and a websocket (hot reload).
 */
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  // The page has a Pay button: it must never be shown inside another site's frame, and it loads nothing from elsewhere.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          // no other site may embed this app's responses, and the page asks for no device features
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          // a page opened from another site gets no handle on this one
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), browsing-topics=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
