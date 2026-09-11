# Documentation site

The user documentation of `sap-fiori-timesheet-mcp`, built with [Astro Starlight](https://starlight.astro.build/)
and organised along [Diátaxis](https://diataxis.fr/): tutorials (`start/`), how-to guides (`install/`, `how-to/`),
reference (`reference/`) and explanation (`explanation/`). Published to GitHub Pages by
`.github/workflows/docs.yml` at <https://arno-vel-bept.github.io/sap-fiori-timesheet-mcp/>.

```bash
pnpm --dir website install
pnpm --dir website dev       # http://localhost:4321/sap-fiori-timesheet-mcp/
pnpm --dir website build     # also validates every internal link (starlight-links-validator)
```

Conventions:

- Pages live in `src/content/docs/`; the sidebar order is fixed in `astro.config.mjs`.
- Internal links are written **relative to the page** (`../../reference/cli/`), so the site works under the
  GitHub Pages base path and anywhere else. The build fails on a broken link.
- Each page opens with a `<span class="doc-kind">` badge naming its Diátaxis kind.
- `cookie` is a direct dependency on purpose: Astro's prerender entry imports it as an external, and without a
  copy in `website/node_modules` Node walks up into the repository's own `node_modules`, where the MCP SDK's
  Express dependency provides an old CommonJS `cookie` that breaks the build.
