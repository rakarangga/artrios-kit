import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App.jsx";
import CognitionApp from "./CognitionApp.jsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@fontsource/dm-sans/latin-400.css";
import "@fontsource/dm-sans/latin-500.css";
import "@fontsource/dm-sans/latin-600.css";
import "@fontsource/archivo/latin-500.css";
import "@fontsource/archivo/latin-600.css";
import "@fontsource/archivo/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";

// Light, dark, or follow the system. next-themes puts the "dark" class on <html> before first paint.
createRoot(document.getElementById("root")).render(
  <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <TooltipProvider delayDuration={200}>
      {/^\/(cognition|chat)(\/|$)/.test(location.pathname) ? <CognitionApp /> : <App />}
    </TooltipProvider>
  </ThemeProvider>,
);
