import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

afterEach(() => cleanup());

describe("Dialog", () => {
  it("keeps focus in the active field when the parent rerenders with a new close callback", () => {
    const { rerender } = render(
      <Dialog open title="Save practice setup" onClose={() => undefined}>
        <label>
          Setup name
          <input defaultValue="Warm-up" />
        </label>
      </Dialog>,
    );
    const input = screen.getByRole("textbox", { name: "Setup name" });
    input.focus();

    rerender(
      <Dialog open title="Save practice setup" onClose={() => undefined}>
        <label>
          Setup name
          <input defaultValue="Warm-up" />
        </label>
      </Dialog>,
    );

    expect(input).toHaveFocus();
  });

  it("traps focus, closes on Escape, and restores the prior focus", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button>Open dialog</button>
        <Dialog open={false} title="Save practice setup" onClose={onClose}>
          <button>Cancel</button>
          <button>Save favorite</button>
        </Dialog>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();

    rerender(
      <>
        <button>Open dialog</button>
        <Dialog open title="Save practice setup" onClose={onClose}>
          <button>Cancel</button>
          <button>Save favorite</button>
        </Dialog>
      </>,
    );

    expect(
      screen.getByRole("dialog", { name: "Save practice setup" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close Save practice setup" }),
    ).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Save favorite" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <button>Open dialog</button>
        <Dialog open={false} title="Save practice setup" onClose={onClose}>
          <button>Cancel</button>
          <button>Save favorite</button>
        </Dialog>
      </>,
    );
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });
});
