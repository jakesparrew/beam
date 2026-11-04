// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VideoBlockView } from "./blocks/video";

afterEach(cleanup);

describe("video facade (rule 22)", () => {
  it("creates the youtube-nocookie iframe only after the click", () => {
    const { container } = render(
      <VideoBlockView
        youtubeId="dQw4w9WgXcQ"
        title="Tour of BEAM"
        poster={{ id: "m1", url: "/api/public/files/f1", width: 1280, height: 720, alt: "", decorative: true, caption: null }}
        playLabel="Play video: Tour of BEAM"
        consentNote="The video loads from YouTube when you press play."
        openLabel="Watch on YouTube"
      />,
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.innerHTML).not.toMatch(/youtube(-nocookie)?\.com|ytimg|google/i);
    fireEvent.click(screen.getByRole("button", { name: "Play video: Tour of BEAM" }));
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
    expect(iframe?.getAttribute("title")).toBe("Tour of BEAM");
    expect(screen.getByRole("link", { name: "Watch on YouTube" }).getAttribute("rel")).toBe("noopener");
  });
});
