import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { SETUP_SECTION, setupHref } from "./setup-sections";

describe("setupHref", () => {
  it("opens the Connections page at the section asked for", () => {
    expect(setupHref("king-lasik", "meta")).toBe("/c/king-lasik/setup#meta");
    expect(setupHref("king-lasik", "google")).toBe("/c/king-lasik/setup#google-ads");
    expect(setupHref("king-lasik", "stages")).toBe("/c/king-lasik/setup#stages");
  });

  it("opens it at the top when no section is named", () => {
    expect(setupHref("king-lasik")).toBe("/c/king-lasik/setup");
  });

  it("gives every section its own anchor", () => {
    const ids = Object.values(SETUP_SECTION);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the redirect back from a sign-in", () => {
  it("🔴 carries the section, so the browser opens the page there", () => {
    // The callbacks build their redirect from the request's own URL, as here.
    const req = new NextRequest("https://dash.example.com/api/oauth/meta/callback?code=x&state=y");
    const back = req.nextUrl.clone();
    back.pathname = "/c/king-lasik/setup";
    back.search = "";
    back.searchParams.set("metaStash", "s1");
    back.hash = SETUP_SECTION.meta;

    expect(NextResponse.redirect(back).headers.get("location")).toBe(
      "https://dash.example.com/c/king-lasik/setup?metaStash=s1#meta",
    );
  });
});
