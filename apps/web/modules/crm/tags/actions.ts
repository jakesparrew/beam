"use server";
/** Tag actions (crm spec 4.1), implemented by crm-P2. crm-P1 stubs with the final names and inputs. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { LocalizedTextSchema } from "@beam/core/i18n";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

const TagInput = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_:-]{1,62}$/),
  name: LocalizedTextSchema,
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  description: z.string().max(500).optional(),
});
const Bulk = z.object({ tagId: z.uuid(), personIds: z.array(z.uuid()).min(1).max(5000) });

export const createTag = action({ name: "crm.create_tag", audience: "staff", permission: "persons.write", input: TagInput }, todo<{ id: string }>("crm.create_tag"));

export const updateTag = action(
  { name: "crm.update_tag", audience: "staff", permission: "persons.write", input: TagInput.extend({ id: z.uuid() }) },
  todo<{ id: string }>("crm.update_tag"),
);

export const deleteTag = action({ name: "crm.delete_tag", audience: "staff", permission: "persons.write", input: z.object({ id: z.uuid() }) }, todo<Record<string, never>>("crm.delete_tag"));

export const tagPersons = action({ name: "crm.tag_persons", audience: "staff", permission: "persons.write", input: Bulk }, todo<{ changed: number }>("crm.tag_persons"));

export const untagPersons = action({ name: "crm.tag_persons", audience: "staff", permission: "persons.write", input: Bulk }, todo<{ changed: number }>("crm.tag_persons"));
