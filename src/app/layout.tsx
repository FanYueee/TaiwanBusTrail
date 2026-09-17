import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "台中公車覆蓋地圖",
  description:
    "顯示台中市公車實際行駛線型（TDX Shape），以紅色／綠色標示個人搭乘過的區段；所有個人資料只存在本機瀏覽器。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
