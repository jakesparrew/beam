/**
 * email-P3: email's permissions (email spec section 7). The three strings are declared once,
 * reach the generated registry, and default to the roles of the spec's table. email-P3 adds no
 * staff action (its sending functions are cross-module calls inside the caller's transaction,
 * and the routes are public or signed); the per-action refusals are tested with the actions of
 * email-P5 and email-P6.
 */
import { describe, expect, it } from "vitest";
import { defaultRolesFor } from "@beam/db/seed/platform";
import { PERMISSIONS } from "@/registry/permissions.generated";
import { permissions } from "./permissions";

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("email permissions", () => {
  it("declares exactly email.write, email.send and campaigns.send, all in the generated registry", () => {
    expect(sorted(permissions)).toEqual(["campaigns.send", "email.send", "email.write"]);
    for (const p of permissions) expect(PERMISSIONS).toContain(p);
  });

  it("email.write defaults to technical_admin, management, marketing and customer_service (owner holds every permission)", () => {
    expect(sorted(defaultRolesFor("email.write"))).toEqual(sorted(["technical_admin", "management", "marketing", "customer_service"]));
  });

  it("email.send and campaigns.send default to technical_admin, management and marketing (and owner)", () => {
    for (const p of ["email.send", "campaigns.send"]) {
      expect(sorted(defaultRolesFor(p))).toEqual(sorted(["technical_admin", "management", "marketing"]));
    }
  });

  it("reception, sales, finance and external partners get none of them", () => {
    for (const p of permissions) {
      for (const role of ["reception", "sales", "finance", "external_partner"] as const) expect(defaultRolesFor(p)).not.toContain(role);
    }
  });
});
