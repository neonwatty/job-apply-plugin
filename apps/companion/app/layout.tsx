import type { ReactNode } from "react";
import "../components/companion.css";
import "../components/resume-facts.css";
export const metadata = { title: "Job Apply Companion", description: "Your local job application workspace" };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
