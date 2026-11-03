import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Input } from "./components/input";
import { Textarea } from "./components/textarea";
import { FormField } from "./form-field";

afterEach(cleanup);

describe("FormField (PL-90)", () => {
  it("requires a label at the type level", () => {
    // The assertion is the `@ts-expect-error`: `pnpm typecheck` fails if `label` ever
    // becomes optional, because the directive would then be unused.
    // prettier-ignore
    // @ts-expect-error label is a required prop
    const withoutLabel = <FormField><Input /></FormField>;
    expect(withoutLabel).toBeTruthy();
  });

  it("labels the control", () => {
    render(
      <FormField label="Email">
        <Input type="email" />
      </FormField>,
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute("type", "email");
  });

  it("links the error through aria-describedby and sets aria-invalid", () => {
    render(
      <FormField label="Title" error="Use 3 to 200 characters.">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText("Title");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).toBeTruthy();
    const error = document.getElementById(describedBy.split(" ").pop()!);
    expect(error).toHaveTextContent("Use 3 to 200 characters.");
    expect(input).toHaveAccessibleDescription("Use 3 to 200 characters.");
  });

  it("describes the control with hint then error and keeps an existing id", () => {
    render(
      <FormField label="Description" hint="Optional." error="Too long.">
        <Textarea id="desc" aria-describedby="extra" />
      </FormField>,
    );
    const textarea = screen.getByLabelText("Description");
    expect(textarea).toHaveAttribute("id", "desc");
    expect(textarea).toHaveAttribute(
      "aria-describedby",
      "extra desc-hint desc-error",
    );
  });

  it("has no aria-invalid and only the hint without an error", () => {
    render(
      <FormField label="Name" hint="As on your ID." required requiredMark=" *">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText(/Name/);
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAccessibleDescription("As on your ID.");
  });
});
