import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

const siteOrigin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://teams.puddingai.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "PuddingTeams Documents",
    template: "%s | PuddingTeams"
  },
  description: "PuddingTeams 架构、部署、协作机制与 Connector Extension 开发文档。"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="light" style={{ colorScheme: "light" }}>
      <body>
        <RootProvider search={{ enabled: false }} theme={{ enabled: false, hotKey: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
