// Cognition in its own browser tab (/cognition?ws=KEY&s=SESSION): full-screen messenger layout, no app sidebar.
// Same server, same cookie, same chat component as the menu screen (layout "full").
import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { T } from "./texts.js";

const CognitionView = lazy(() => import("./views/Cognition.jsx"));

export default function CognitionApp() {
  const q = new URLSearchParams(location.search);
  return (
    <div className="relative">
      <Suspense fallback={<div className="grid h-svh place-items-center"><LoaderCircle className="size-5 animate-spin" /></div>}>
        <CognitionView layout="full" headerExtra={<ThemeToggle labels={T.theme} />} workspace={q.get("ws") || null} initialSession={q.get("s") ?? undefined}
          onOpenPutusan={() => window.open("/?view=putusan", "_blank", "noopener")} />
      </Suspense>
    </div>
  );
}
