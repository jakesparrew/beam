import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/dialog";
import {
  ReportProblemDialog,
  type ReportProblemLabels,
} from "./report-problem-dialog";

afterEach(cleanup);

// jsdom has no ResizeObserver; Radix radio and checkbox measure themselves with it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function Example() {
  return (
    <>
      <button type="button">Before</button>
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open dialog</Button>
        </DialogTrigger>
        <DialogContent closeLabel="Close">
          <DialogTitle>Invite staff user</DialogTitle>
          <DialogDescription>They receive an email.</DialogDescription>
          <input aria-label="Email" />
          <Button>Send invite</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("Dialog (PL-90)", () => {
  it("traps focus while open and returns it to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", {
      name: "Invite staff user",
    });
    expect(dialog).toHaveAccessibleDescription("They receive an email.");
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    );

    // Tab around more times than there are controls: focus never leaves the dialog.
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Outside content is hidden from assistive technology while the dialog is modal.
    expect(
      screen.getByRole("button", { name: "Before", hidden: true }),
    ).not.toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the trigger when closed with the close button", async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });
});

const labels: ReportProblemLabels = {
  title: "Report a problem",
  description: "Tell us what went wrong.",
  titleField: "Title",
  descriptionField: "Description",
  severityField: "Severity",
  severities: {
    critical: { label: "Critical", example: "Nobody can book or pay." },
    high: { label: "High", example: "An important function fails." },
    normal: {
      label: "Normal",
      example: "Something is wrong but there is a workaround.",
    },
    improvement: { label: "Improvement", example: "A wish or a small change." },
  },
  emergency: "For critical problems also call {phone}.",
  titleLength: "Use 3 to 200 characters.",
  submit: "Send",
  submitting: "Sending…",
  cancel: "Cancel",
  close: "Close",
  success: "Thank you. Your reference is {reference}.",
};

describe("ReportProblemDialog (PL-86)", () => {
  it("submits title, description, severity and page url and shows the reference", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        data: { reference: "SUP-2026-0001" },
      }),
    );
    render(
      <ReportProblemDialog
        onSubmit={onSubmit}
        labels={labels}
        emergencyPhone="+32 470 00 00 00"
        pageUrl="https://beam.example.com/admin/system"
        trigger={<Button>Report a problem</Button>}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Report a problem" }));
    await user.type(
      await screen.findByLabelText("Title"),
      "Calendar does not load",
    );
    await user.type(screen.getByLabelText("Description"), "Spinner forever");
    await user.click(screen.getByRole("radio", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: "Calendar does not load",
      description: "Spinner forever",
      severity: "high",
      pageUrl: "https://beam.example.com/admin/system",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your reference is SUP-2026-0001.",
    );
  });

  it("shows the emergency phone only for critical", async () => {
    const user = userEvent.setup();
    render(
      <ReportProblemDialog
        onSubmit={vi.fn()}
        labels={labels}
        emergencyPhone="+32 470 00 00 00"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(
      screen.queryByRole("link", { name: "+32 470 00 00 00" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Critical" }));
    expect(
      screen.getByRole("link", { name: "+32 470 00 00 00" }),
    ).toHaveAttribute("href", "tel:+32470000000");
  });

  it("validates the title length before calling the action and shows action errors", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: {
          message: "Something went wrong",
          fields: { description: "Too long" },
        },
      }),
    );
    render(
      <ReportProblemDialog
        onSubmit={onSubmit}
        labels={labels}
        emergencyPhone="+32"
        open
        onOpenChange={() => {}}
      />,
    );
    await user.type(screen.getByLabelText("Title"), "ab");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Title")).toHaveAccessibleDescription(
      "Use 3 to 200 characters.",
    );

    await user.type(screen.getByLabelText("Title"), "c");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toHaveAccessibleDescription(
      "Too long",
    );
  });
});
