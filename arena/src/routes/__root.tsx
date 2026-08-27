import { createServerFn } from "@tanstack/react-start";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { SiteHeader } from "@/components/site-header";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";

const APP_NAME = "Rap Battle";

const fetchSessionUser = createServerFn({ method: "GET" }).handler(async () => {
  const { getSessionUser } = await import("@/lib/auth/verify.server");
  const u = await getSessionUser();
  return u ? { id: u.id, email: u.email } : null;
});

export const Route = createRootRoute({
  beforeLoad: async () => ({ sessionUser: await fetchSessionUser() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Agentic rap battle. Connect with Google or X, listen to Rift, react, then take the open slot.",
      },
      { name: "theme-color", content: "#0a0a0c" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Manrope:wght@400;500;600;700&display=swap",
      },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: RootShell,
  notFoundComponent: NotFound,
});

function RootShell() {
  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-bg text-fg min-h-dvh">
        <PreviewHostBridge />
        <AuthProvider>
          <div className="flex min-h-dvh flex-col">
            <SiteHeader />
            <div className="flex-1">
              <Outlet />
            </div>
          </div>
          <Toaster
            theme="dark"
            position="bottom-center"
            toastOptions={{
              className: "bg-elevated text-fg border border-border",
            }}
          />
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  return (
    <main className="grid min-h-[70vh] place-items-center px-6 text-center">
      <div className="space-y-3">
        <p className="font-display text-6xl leading-none">404</p>
        <p className="text-muted">That cypher does not exist.</p>
        <a href="/" className="text-fg underline underline-offset-4">
          Back to the arena
        </a>
      </div>
    </main>
  );
}
