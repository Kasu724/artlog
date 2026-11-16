import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("ArtLog welcome screen", () => {
  it("explains local storage and offers a project folder action", () => {
    render(<App />);
    expect(
      screen.getByRole("button", { name: /open a project folder/i }),
    ).toBeTruthy();
    expect(screen.getByText(/your files stay on this device/i)).toBeTruthy();
  });
});
