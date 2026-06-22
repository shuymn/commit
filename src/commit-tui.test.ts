import { describe, expect, test } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { CommitTuiView } from "./commit-tui";

function stripAnsi(text: string): string {
  const escapeChar = String.fromCharCode(27);
  return text.replace(new RegExp(`${escapeChar}\\[[0-9;]*m`, "g"), "");
}

describe("CommitTuiView", () => {
  test("renders a single feed with footer and auto-follow", () => {
    const view = new CommitTuiView({ rows: 6 });

    expect(stripAnsi(view.render(80).join("\n"))).toContain("Starting commit workflow...");

    view.addComponent(new Text("first", 0, 0));
    view.addComponent(new Text("second", 0, 0));
    view.addComponent(new Text("third", 0, 0));
    view.addComponent(new Text("fourth", 0, 0));

    const rendered = stripAnsi(view.render(80).join("\n"));
    expect(rendered).not.toContain("first");
    expect(rendered).toContain("second");
    expect(rendered).toContain("fourth");
    expect(rendered).toContain("follow");
  });

  test("scrolls away from and back to the bottom", () => {
    const view = new CommitTuiView({ rows: 6 });
    view.addComponent(new Text("first", 0, 0));
    view.addComponent(new Text("second", 0, 0));
    view.addComponent(new Text("third", 0, 0));
    view.addComponent(new Text("fourth", 0, 0));

    view.handleInput("\x1b[A");
    const scrolled = stripAnsi(view.render(80).join("\n"));
    expect(scrolled).toContain("first");
    expect(scrolled).toContain("scroll 1");

    view.handleInput("\x1b[F");
    const bottom = stripAnsi(view.render(80).join("\n"));
    expect(bottom).not.toContain("first");
    expect(bottom).toContain("follow");
  });

  test("shows cancellation warning in the footer", () => {
    const view = new CommitTuiView({ rows: 5 });

    view.setCancelWarning(true);

    expect(stripAnsi(view.render(80).join("\n"))).toContain("Press Ctrl+C again to cancel");
  });

  test("clears cancellation warning on terminal status", () => {
    const view = new CommitTuiView({ rows: 5 });

    view.setCancelWarning(true);
    view.setStatus("completed");

    const rendered = stripAnsi(view.render(80).join("\n"));
    expect(rendered).not.toContain("Press Ctrl+C again to cancel");
    expect(rendered).toContain("completed");
  });
});
