import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: "https://github.com/kungfufafa/atlas",
    links: [
      {
        external: true,
        text: "Managed hosting",
        url: "https://getnakama.cloud/",
      },
    ],
    nav: {
      title: "Atlas",
    },
  };
}
