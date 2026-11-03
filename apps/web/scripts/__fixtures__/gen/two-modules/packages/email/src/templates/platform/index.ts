import MagicLink from "./magic-link";
import { StaffInvite } from "./staff-invite.tsx";

const defineTemplate = <T>(def: T): T => def;

export const templates = [
  defineTemplate({ name: "staff_invite", component: StaffInvite }),
  defineTemplate({ name: "magic_link", component: MagicLink }),
];
