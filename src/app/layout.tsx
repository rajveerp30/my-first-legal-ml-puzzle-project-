import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Puzzle Hands — a little hand-gesture jigsaw",
  description: "Snap a photo with two hands, then pinch the pieces back together. Made by Rajveer Pakhale / TeenDev.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <script
          // Avoid a flash of the wrong theme before hydration
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var t = localStorage.getItem('puzzlehands-theme');
                if (!t) { t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
                document.documentElement.classList.toggle('dark', t === 'dark');
                document.documentElement.setAttribute('data-theme', t);
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
