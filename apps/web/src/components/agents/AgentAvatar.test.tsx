// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar.tsx";

afterEach(cleanup);

describe("AgentAvatar", () => {
  it("renders a circular cover image and falls back when loading fails", () => {
    const { container, rerender } = render(
      <AgentAvatar agent={{ scope: "global", name: "writer", avatarUrl: "/avatar/one" }} />,
    );
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/avatar/one");
    expect(image.className).toContain("object-cover");
    expect(image.parentElement?.className).toContain("rounded-full");

    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();

    rerender(<AgentAvatar agent={{ scope: "global", name: "writer", avatarUrl: "/avatar/two" }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/avatar/two");
  });
});
