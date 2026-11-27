import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./components/button";
import { Input } from "./components/input";
import { FormField } from "./form-field";
import { StepForm, type StepFormLabels } from "./step-form";

afterEach(cleanup);

const labels: StepFormLabels = {
  next: "Next",
  previous: "Back",
  progress: "Step {current} of {total}",
  review: "Review",
  reviewIntro: "Check your answers.",
  edit: "Edit",
  enterHint: "or press Enter",
  yes: "Yes",
  no: "No",
};

function Example({ onSubmit, withLabels = true }: { onSubmit?: (data: FormData) => void; withLabels?: boolean }) {
  return (
    <StepForm
      labels={withLabels ? labels : undefined}
      aria-label="New session"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(new FormData(e.currentTarget));
      }}
      footer={<Button type="submit">Save</Button>}
    >
      <fieldset data-step>
        <legend>Basics</legend>
        <FormField label="Title" required requiredMark=" *">
          <Input name="title" required />
        </FormField>
      </fieldset>
      <fieldset data-step>
        <legend>Planning</legend>
        <FormField label="Seats">
          <Input name="seats" type="number" defaultValue="12" />
        </FormField>
        <label>
          <input type="checkbox" name="memberOnly" /> Members only
        </label>
      </fieldset>
    </StepForm>
  );
}

const visibleSteps = () => Array.from(document.querySelectorAll("fieldset[data-step]")).filter((fs) => !(fs as HTMLFieldSetElement).hidden);

describe("StepForm", () => {
  it("renders every section and the submit row without JS (server render)", () => {
    const html = renderToString(<Example />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const sets = doc.querySelectorAll("fieldset[data-step]");
    expect(sets).toHaveLength(2);
    sets.forEach((fs) => expect(fs.hasAttribute("hidden")).toBe(false));
    expect(doc.querySelector("button[type='submit']")?.textContent).toBe("Save");
    expect(doc.querySelector("[data-testid='step-form-next']")).toBeNull();
    expect(doc.querySelector("form")?.hasAttribute("data-enhanced")).toBe(false);
  });

  it("stays a plain form with every section when no labels are given", () => {
    render(<Example withLabels={false} />);
    expect(visibleSteps()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByTestId("step-form-next")).toBeNull();
  });

  it("shows one step at a time and checks the step's required fields before moving on", async () => {
    const user = userEvent.setup();
    render(<Example />);
    expect(visibleSteps()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Basics" })).toBeInTheDocument();
    expect(screen.getByText("Step 1 of 3")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 2, name: "Basics" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Title/)).toHaveFocus();

    await user.type(screen.getByLabelText(/Title/), "Sound bath");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 2, name: "Planning" })).toHaveFocus();
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Seats")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { level: 2, name: "Basics" })).toHaveFocus();
    expect(screen.getByLabelText(/Title/)).toHaveValue("Sound bath");
  });

  it("goes to the next step on Enter and submits from the review with every answer", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Example onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/Title/), "Sound bath{Enter}");
    expect(screen.getByRole("heading", { level: 2, name: "Planning" })).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText("Members only"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { level: 2, name: "Review" })).toHaveFocus();
    expect(visibleSteps()).toHaveLength(0);
    const basics = screen.getByRole("region", { name: "Basics" });
    expect(within(basics).getByText("Title").nextSibling).toHaveTextContent("Sound bath");
    const planning = screen.getByRole("region", { name: "Planning" });
    expect(within(planning).getByText("Seats").nextSibling).toHaveTextContent("12");
    expect(within(planning).getByText("Members only").nextSibling).toHaveTextContent("Yes");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data = onSubmit.mock.calls[0]![0] as FormData;
    expect(data.get("title")).toBe("Sound bath");
    expect(data.get("seats")).toBe("12");
    expect(data.get("memberOnly")).toBe("on");

    await user.click(within(basics).getByRole("button", { name: "Edit: Basics" }));
    expect(screen.getByRole("heading", { level: 2, name: "Basics" })).toHaveFocus();
  });
});
