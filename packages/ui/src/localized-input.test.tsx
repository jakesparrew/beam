import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalizedInput, type LocalizedValue } from "./localized-input";

afterEach(cleanup);

const LOCALES = ["nl-BE", "fr-BE", "en"] as const;
type Locale = (typeof LOCALES)[number];

const labels = {
  field: "Title",
  locales: { "nl-BE": "Nederlands", "fr-BE": "Français", en: "English" },
  missing: "Missing",
  complete: "Complete",
};

function badge(locale: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-slot="locale-badge"][data-locale="${locale}"]`,
  );
  if (!el) throw new Error(`no badge for ${locale}`);
  return el;
}

describe("LocalizedInput", () => {
  it("shows the missing badge for fr-BE and complete for the others", () => {
    render(
      <LocalizedInput<Locale>
        name="title"
        value={{ "nl-BE": "Yoga voor beginners", en: "Yoga for beginners" }}
        onChange={() => {}}
        locales={LOCALES}
        labels={labels}
      />,
    );
    expect(badge("fr-BE")).toHaveTextContent("Missing");
    expect(badge("nl-BE")).toHaveTextContent("Complete");
    expect(badge("en")).toHaveTextContent("Complete");
    expect(screen.getByRole("tab", { name: /Français/ })).toHaveAttribute(
      "data-complete",
      "false",
    );
  });

  it("treats whitespace-only text as missing", () => {
    render(
      <LocalizedInput
        name="t"
        value={{ "nl-BE": "   " }}
        onChange={() => {}}
        locales={["nl-BE"]}
        labels={labels}
      />,
    );
    expect(badge("nl-BE")).toHaveTextContent("Missing");
  });

  it("renders one labelled input per locale with its lang and edits through tabs", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<LocalizedValue<Locale>>({
        "nl-BE": "Hallo",
      });
      return (
        <LocalizedInput<Locale>
          name="title"
          value={value}
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
          locales={LOCALES}
          labels={labels}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByLabelText("Title (Nederlands)")).toHaveValue("Hallo");
    expect(screen.getByLabelText("Title (Nederlands)")).toHaveAttribute(
      "lang",
      "nl-BE",
    );

    await user.click(screen.getByRole("tab", { name: /Français/ }));
    const fr = screen.getByLabelText("Title (Français)");
    await user.type(fr, "Bonjour");
    expect(onChange).toHaveBeenLastCalledWith({
      "nl-BE": "Hallo",
      "fr-BE": "Bonjour",
    });
    expect(badge("fr-BE")).toHaveTextContent("Complete");
    const hidden = document.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="title"]',
    );
    expect(JSON.parse(hidden!.value)).toEqual({
      "nl-BE": "Hallo",
      "fr-BE": "Bonjour",
    });
  });

  it("renders textareas when multiline and links the error", () => {
    render(
      <LocalizedInput
        name="d"
        value={{}}
        locales={["en"]}
        multiline
        labels={labels}
        error="Fill in every language before publishing."
      />,
    );
    const control = screen.getByLabelText("Title (English)");
    expect(control.tagName).toBe("TEXTAREA");
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(control).toHaveAccessibleDescription(
      "Fill in every language before publishing.",
    );
  });

  it("keeps its own state when uncontrolled", async () => {
    const user = userEvent.setup();
    render(
      <LocalizedInput name="u" value={{}} locales={["en"]} labels={labels} />,
    );
    await user.type(screen.getByLabelText("Title (English)"), "Hi");
    expect(badge("en")).toHaveTextContent("Complete");
  });
});
