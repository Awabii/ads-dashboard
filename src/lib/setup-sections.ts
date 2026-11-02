/**
 * Anchors for the sections of a client's Connections page (`/c/<slug>/setup`).
 *
 * A platform sign-in leaves the page and comes back as a fresh load, and a fresh
 * load opens at the top. The account picker the operator came back for sat two
 * or three sections down, so after every connect they had to scroll to find it.
 * The callbacks return to the platform's own section by these ids instead, and
 * the result page's links back do the same.
 */
export const SETUP_SECTION = {
  ghl: "gohighlevel",
  stages: "stages",
  meta: "meta",
  google: "google-ads",
  tiktok: "tiktok",
} as const;

export type SetupSection = keyof typeof SETUP_SECTION;

/** The Connections page, opened at one section when given. */
export function setupHref(slug: string, section?: SetupSection): string {
  return `/c/${slug}/setup${section ? `#${SETUP_SECTION[section]}` : ""}`;
}
