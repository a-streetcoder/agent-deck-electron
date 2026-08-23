// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectImage } from "./ProjectImage.tsx";

afterEach(cleanup);

describe("ProjectImage", () => {
  it("cover-crops managed artwork with the project corner ratio and falls back on error", () => {
    const { container } = render(
      <ProjectImage
        project={{ name: "Deck", type: "node", imageUrl: "/project-images/id?v=hash" }}
      />,
    );
    const frame = container.firstElementChild as HTMLElement;
    const image = container.querySelector("img")!;
    expect(frame.style.borderRadius).toBe("9px");
    expect(image.className).toContain("object-cover");

    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-testid='project-type-icon-node']")).not.toBeNull();
  });
});
