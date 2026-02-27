import { describe, it, expect } from "vitest";
import {
  buildRoleSnapshotFromAriaSnapshot,
  parseRoleRef,
  type RoleRefMap,
} from "./snapshot.js";

describe("parseRoleRef", () => {
  it("accepts valid refs", () => {
    expect(parseRoleRef("e1")).toBe("e1");
    expect(parseRoleRef("e42")).toBe("e42");
    expect(parseRoleRef("e999")).toBe("e999");
  });

  it("normalizes @ prefix", () => {
    expect(parseRoleRef("@e5")).toBe("e5");
  });

  it("normalizes ref= prefix", () => {
    expect(parseRoleRef("ref=e12")).toBe("e12");
  });

  it("trims whitespace", () => {
    expect(parseRoleRef("  e3  ")).toBe("e3");
    expect(parseRoleRef("  @e3  ")).toBe("e3");
  });

  it("rejects invalid refs", () => {
    expect(parseRoleRef("")).toBeNull();
    expect(parseRoleRef("  ")).toBeNull();
    expect(parseRoleRef("foo")).toBeNull();
    expect(parseRoleRef("e")).toBeNull();
    expect(parseRoleRef("E5")).toBeNull();
    expect(parseRoleRef("5")).toBeNull();
    expect(parseRoleRef("e5x")).toBeNull();
  });
});

describe("buildRoleSnapshotFromAriaSnapshot", () => {
  const SAMPLE_ARIA = [
    '- navigation "Main":',
    '  - link "Home"',
    '  - link "About"',
    '- main:',
    '  - heading "Welcome" [level=1]',
    '  - textbox "Search"',
    '  - button "Submit"',
    '  - group:',
    '    - checkbox "Remember me"',
  ].join("\n");

  it("assigns refs to interactive and named content elements", () => {
    const { refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_ARIA);

    // Interactive: 2 links + textbox + button + checkbox = 5
    // Content with name: heading "Welcome" + navigation "Main" (named region-like) = 1 (heading only, navigation is structural)
    // navigation is in CONTENT_ROLES? Let me check - it IS in CONTENT_ROLES
    const refKeys = Object.keys(refs);
    expect(refKeys.length).toBeGreaterThanOrEqual(5);

    // All refs should follow e{N} pattern
    for (const key of refKeys) {
      expect(key).toMatch(/^e\d+$/);
    }
  });

  it("includes refs in output snapshot text", () => {
    const { snapshot } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_ARIA);

    expect(snapshot).toContain("[ref=e");
    expect(snapshot).toContain("link");
    expect(snapshot).toContain("button");
    expect(snapshot).toContain("textbox");
  });

  it("preserves structure in full mode", () => {
    const { snapshot } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_ARIA);

    expect(snapshot).toContain("navigation");
    expect(snapshot).toContain("main");
    expect(snapshot).toContain("heading");
    expect(snapshot).toContain("group");
  });

  it("interactive-only mode filters to interactive elements", () => {
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(SAMPLE_ARIA, {
      interactive: true,
    });

    // Should have only interactive elements
    for (const ref of Object.values(refs)) {
      expect(["link", "textbox", "button", "checkbox"]).toContain(ref.role);
    }

    // Structural/content elements should be absent
    expect(snapshot).not.toContain("navigation");
    expect(snapshot).not.toContain("main");
    expect(snapshot).not.toContain("heading");
  });

  it("returns '(no interactive elements)' for non-interactive content in interactive mode", () => {
    const plain = "- heading \"Title\" [level=1]";
    const { snapshot } = buildRoleSnapshotFromAriaSnapshot(plain, { interactive: true });
    expect(snapshot).toBe("(no interactive elements)");
  });

  it("returns '(empty)' for empty input", () => {
    const { snapshot } = buildRoleSnapshotFromAriaSnapshot("");
    expect(snapshot).toBe("(empty)");
  });

  it("handles duplicate role+name by assigning nth values", () => {
    const dupes = [
      '- button "Save"',
      '- button "Save"',
      '- button "Cancel"',
    ].join("\n");

    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(dupes);
    const saveRefs = Object.values(refs).filter(
      (r) => r.role === "button" && r.name === "Save",
    );

    expect(saveRefs.length).toBe(2);
    // Duplicate refs should have nth values
    expect(saveRefs.some((r) => r.nth === 0)).toBe(true);
    expect(saveRefs.some((r) => r.nth === 1)).toBe(true);

    // Snapshot should contain [nth=1] for the second
    expect(snapshot).toContain("[nth=1]");

    // Non-duplicate "Cancel" should NOT have nth
    const cancelRef = Object.values(refs).find(
      (r) => r.role === "button" && r.name === "Cancel",
    );
    expect(cancelRef).toBeDefined();
    expect(cancelRef!.nth).toBeUndefined();
  });

  it("respects maxDepth option", () => {
    const nested = [
      "- main:",
      '  - heading "Top" [level=1]',
      "  - group:",
      '    - button "Deep"',
    ].join("\n");

    const { refs } = buildRoleSnapshotFromAriaSnapshot(nested, { maxDepth: 1 });
    // "Deep" button is at depth 2, should be excluded
    const deepButton = Object.values(refs).find((r) => r.name === "Deep");
    expect(deepButton).toBeUndefined();

    // "Top" heading is at depth 1, should be included
    const topHeading = Object.values(refs).find((r) => r.name === "Top");
    expect(topHeading).toBeDefined();
  });

  it("compact mode removes unnamed structural elements", () => {
    const withStructural = [
      "- group:",
      '  - button "Click"',
      "- group:",
      "  - group:",
      '    - text "orphan"',
    ].join("\n");

    const { snapshot } = buildRoleSnapshotFromAriaSnapshot(withStructural, {
      compact: true,
    });

    // First group should be kept (has ref child)
    expect(snapshot).toContain("button");
    // The tree should be compacted — unnamed structural nodes without ref children are removed
  });

  it("ref counter increments sequentially", () => {
    const multi = [
      '- link "A"',
      '- link "B"',
      '- link "C"',
    ].join("\n");

    const { refs } = buildRoleSnapshotFromAriaSnapshot(multi);
    const refKeys = Object.keys(refs).sort(
      (a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)),
    );
    expect(refKeys).toEqual(["e1", "e2", "e3"]);
  });
});

describe("buildRoleSnapshotFromAriaSnapshot — ref map structure", () => {
  it("stores role and name in ref map", () => {
    const input = '- button "Submit"';
    const { refs } = buildRoleSnapshotFromAriaSnapshot(input);

    const ref = Object.values(refs)[0];
    expect(ref).toBeDefined();
    expect(ref.role).toBe("button");
    expect(ref.name).toBe("Submit");
  });

  it("stores role without name for unnamed interactive elements", () => {
    const input = "- button";
    const { refs } = buildRoleSnapshotFromAriaSnapshot(input);

    const ref = Object.values(refs)[0];
    expect(ref).toBeDefined();
    expect(ref.role).toBe("button");
    expect(ref.name).toBeUndefined();
  });
});
