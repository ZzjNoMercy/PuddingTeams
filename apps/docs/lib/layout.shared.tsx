import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BrandLabel } from "@/components/brand";

const githubUrl = "https://github.com/ZzjNoMercy/PuddingTeams";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: <BrandLabel /> },
    links: [
      { text: "README", url: githubUrl, external: true },
      { text: "PuddingAI", url: "https://puddingai.com", external: true },
      { text: "GitHub", url: githubUrl, external: true }
    ],
    githubUrl,
    searchToggle: { enabled: false },
    themeSwitch: { enabled: false }
  };
}
