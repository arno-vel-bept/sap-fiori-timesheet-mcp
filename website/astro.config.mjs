// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLinksValidator from "starlight-links-validator";

// The site is published with GitHub Pages under the repository name, so it is served from a
// sub-path (`base`). Internal links in the content are therefore written base-absolute
// (`/sap-fiori-timesheet-mcp/...`), the same form Starlight emits for its own navigation, so
// they resolve correctly regardless of whether the current URL has a trailing slash. If the
// base changes, update it here and in the content links (see website/README.md).
const BASE = "/sap-fiori-timesheet-mcp";
export default defineConfig({
  site: "https://arno-vel-bept.github.io",
  base: BASE,
  integrations: [
    starlight({
      title: "SAP Fiori Timesheet",
      description: "Fill in SAP Fiori timesheets from the terminal or from an AI assistant.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/arno-vel-bept/sap-fiori-timesheet-mcp" }],
      editLink: { baseUrl: "https://github.com/arno-vel-bept/sap-fiori-timesheet-mcp/edit/main/website/" },
      customCss: ["./src/styles/custom.css"],
      // Internal links are base-absolute; forbid relative ones so the base is never dropped.
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: true })],
      sidebar: [
        { label: "Start here", items: [{ slug: "start/what-it-does" }, { slug: "start/first-timesheet-claude-desktop" }, { slug: "start/first-timesheet-cli" }] },
        {
          label: "Install",
          items: [{ slug: "install/claude-desktop" }, { slug: "install/other-mcp-clients" }, { slug: "install/cli" }, { slug: "install/other-sap-systems" }],
        },
        {
          label: "How-to guides",
          items: [
            { slug: "how-to/sign-in" },
            { slug: "how-to/see-missing-days" },
            { slug: "how-to/book-days" },
            { slug: "how-to/check-jobcodes" },
            { slug: "how-to/apply-staffing" },
            { slug: "how-to/fill-open-period" },
            { slug: "how-to/several-projects-per-day" },
            { slug: "how-to/project-proportions" },
            { slug: "how-to/balance-proportions" },
            { slug: "how-to/favorites" },
            { slug: "how-to/troubleshoot" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "reference/cli" },
            { slug: "reference/mcp-tools" },
            { slug: "reference/configuration" },
            { slug: "reference/jobcodes" },
            { slug: "reference/files-and-exit-codes" },
            { slug: "reference/sap-odata" },
          ],
        },
        {
          label: "Explanation",
          items: [
            { slug: "explanation/how-authentication-works" },
            { slug: "explanation/security" },
            { slug: "explanation/supported-today" },
            { slug: "explanation/timesheet-concepts" },
            { slug: "explanation/architecture" },
          ],
        },
      ],
    }),
  ],
});
