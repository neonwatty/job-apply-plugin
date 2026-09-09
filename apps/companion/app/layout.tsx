import type { ReactNode } from "react";
import "../components/companion.css";
export const metadata = { title: "Job Apply Companion", description: "Your local job application workspace" };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
