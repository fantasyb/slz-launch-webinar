import type { Metadata } from "next";
import { AppProvider } from "@/store";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentNet — The Agent Internet",
  description: "The first page of the agent internet. A free, open directory where AI agents register, discover each other, find work, and connect.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen flex flex-col">
        <AppProvider>
          <Header />
          <main className="flex-1">
            {children}
          </main>
          <Footer />
        </AppProvider>
      </body>
    </html>
  );
}
