import { describe, it, expect } from "vitest";
import { SimpleRouter } from "../js/router";

describe("SimpleRouter", () => {
    let router: SimpleRouter;

    beforeEach(() => {
        router = new SimpleRouter();
    });

    // ── splitRoute ────────────────────────────────────────────────────────────

    describe("splitRoute", () => {
        it("splits a simple path into segments", () => {
            expect(router.splitRoute("/servers/edit")).toEqual(["servers", "edit"]);
        });

        it("strips leading slash", () => {
            expect(router.splitRoute("/notes")).toEqual(["notes"]);
        });

        it("strips trailing slash", () => {
            expect(router.splitRoute("/notes/")).toEqual(["notes"]);
        });

        it("returns empty array for root path", () => {
            expect(router.splitRoute("/")).toEqual([]);
        });

        it("strips query string before splitting", () => {
            expect(router.splitRoute("/servers/edit?host=192.168.1.5&username=admin")).toEqual(
                ["servers", "edit"]
            );
        });

        it("strips hash fragment before splitting", () => {
            expect(router.splitRoute("/note/abc123#section")).toEqual(["note", "abc123"]);
        });

        // Regression: path-param route /servers/edit/:host/:username with
        // host="192.168.1.5" and username="" produced a trailing slash
        // "/servers/edit/192.168.1.5/" → only 3 segments, not 4, so the route
        // never matched and the wildcard (*) fell through to HomeComponent.
        it("filters empty segments (regression: empty username in path param)", () => {
            const segments = router.splitRoute("/servers/edit/192.168.1.5/");
            expect(segments).toEqual(["servers", "edit", "192.168.1.5"]);
            expect(segments).toHaveLength(3); // NOT 4 — proves the filter(Boolean) behaviour
        });

        it("handles a path-param route pattern", () => {
            expect(router.splitRoute("/applications/edit/:url/:username")).toEqual([
                "applications",
                "edit",
                ":url",
                ":username",
            ]);
        });
    });

    // ── doRoutesMatch ─────────────────────────────────────────────────────────

    describe("doRoutesMatch", () => {
        it("matches identical static routes", () => {
            expect(router.doRoutesMatch("/applications", "/applications")).toBe(true);
        });

        it("does not match routes with different depth", () => {
            expect(router.doRoutesMatch("/applications/add", "/applications")).toBe(false);
        });

        it("matches a parametric route", () => {
            expect(
                router.doRoutesMatch("/note/abc-123", "/note/:id")
            ).toBe(true);
        });

        it("matches a multi-param route", () => {
            expect(
                router.doRoutesMatch(
                    "/applications/edit/https%3A%2F%2Ferp.example.com/admin",
                    "/applications/edit/:url/:username"
                )
            ).toBe(true);
        });

        it("does not match when segment count differs", () => {
            expect(
                router.doRoutesMatch(
                    "/servers/edit/192.168.1.5/",   // 3 segments after filter(Boolean)
                    "/servers/edit/:host/:username"  // expects 4 segments
                )
            ).toBe(false);
        });

        // Fix verification: query-param route matches regardless of param values.
        it("matches /servers/edit?host=...&username= against /servers/edit", () => {
            expect(
                router.doRoutesMatch(
                    "/servers/edit?host=192.168.1.5&username=admin",
                    "/servers/edit"
                )
            ).toBe(true);
        });

        it("matches /servers/edit?host=...&username= even with empty username", () => {
            expect(
                router.doRoutesMatch(
                    "/servers/edit?host=192.168.1.5&username=",
                    "/servers/edit"
                )
            ).toBe(true);
        });

        it("matches wildcard route", () => {
            expect(router.doRoutesMatch("/anything/unknown", "*")).toBe(true);
        });

        it("matches root route", () => {
            expect(router.doRoutesMatch("/", "/")).toBe(true);
        });
    });

    // ── getRouteParams ────────────────────────────────────────────────────────

    describe("getRouteParams", () => {
        it("extracts a single param", () => {
            const params = router.getRouteParams("/note/abc-123", "/note/:id");
            expect(params.get("id")).toBe("abc-123");
        });

        it("extracts multiple params", () => {
            const params = router.getRouteParams(
                "/servers/deploy/192.168.1.100/admin",
                "/servers/deploy/:host/:username"
            );
            expect(params.get("host")).toBe("192.168.1.100");
            expect(params.get("username")).toBe("admin");
        });

        it("decodes percent-encoded segments", () => {
            const params = router.getRouteParams(
                "/applications/edit/https%3A%2F%2Ferp.example.com/admin",
                "/applications/edit/:url/:username"
            );
            expect(params.get("url")).toBe("https://erp.example.com");
        });

        it("returns empty map for a static route", () => {
            const params = router.getRouteParams("/applications", "/applications");
            expect(params.size).toBe(0);
        });
    });

    // ── getComponent ─────────────────────────────────────────────────────────

    describe("getComponent", () => {
        it("returns a component for /", () => {
            const result = router.getComponent("/");
            expect(result.component).toBeDefined();
        });

        it("returns a component for /applications", () => {
            const result = router.getComponent("/applications");
            expect(result.component).toBeDefined();
        });

        it("returns a component for /servers/edit with query params", () => {
            const result = router.getComponent("/servers/edit?host=192.168.1.5&username=");
            expect(result.component).toBeDefined();
            // Should resolve to ServersEditComponent, not HomeComponent wildcard
            const home = router.getComponent("/").component;
            const edit = router.getComponent("/servers/edit?host=192.168.1.5&username=").component;
            // Both may be HomeComponent (since wildcard also points there),
            // but the route must have been matched (not fallen through) —
            // verify by checking the matched pathname is /servers/edit
            expect(router.getMatchingRoute("/servers/edit?host=192.168.1.5&username=")).toBe(
                "/servers/edit"
            );
        });

        it("returns the wildcard component for an unknown route", () => {
            const unknown = router.getComponent("/this/route/does/not/exist");
            const wildcard = router.getMatchingRoute("/this/route/does/not/exist");
            expect(wildcard).toBe("*");
            expect(unknown.component).toBeDefined();
        });
    });

    // ── getMatchingRoute ──────────────────────────────────────────────────────

    describe("getMatchingRoute", () => {
        it("returns the exact pathname for a static route", () => {
            expect(router.getMatchingRoute("/applications")).toBe("/applications");
        });

        it("returns the parametric pathname for a param route", () => {
            expect(router.getMatchingRoute("/note/abc-123")).toBe("/note/:id");
        });

        it("returns /servers/edit for /servers/edit?host=x&username=y", () => {
            expect(
                router.getMatchingRoute("/servers/edit?host=192.168.1.5&username=admin")
            ).toBe("/servers/edit");
        });

        it("returns * for an unknown route", () => {
            expect(router.getMatchingRoute("/no/such/path")).toBe("*");
        });
    });
});
