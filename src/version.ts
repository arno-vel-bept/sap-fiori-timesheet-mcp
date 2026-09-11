/**
 * Single source of truth for the running code's version.
 *
 * Kept equal to package.json "version" and manifest.json "version" by
 * test/mcpb-manifest.test.ts (the build fails if the three drift apart).
 * Bump all three together in the same commit.
 */
export const VERSION = "0.5.2";
