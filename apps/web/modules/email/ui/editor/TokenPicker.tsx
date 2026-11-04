"use client";
/**
 * Token and merge-field picker of the editor (email spec rule 23): the personalisation tokens
 * (`{{first_name}}`, ...) and every registered module merge field (`{{webinar.title}}`), with an
 * optional plain-text fallback (`{{first_name|friend}}`). Picking one hands the token text to the
 * field that opened the picker.
 */
import { useState } from "react";
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@beam/ui";
import { EMAIL_TOKENS } from "@beam/core/email";
import { lab, type EditorLabels } from "./BlockCanvas";

export type TokenPickerProps = {
  mergeFields: readonly string[];
  onInsert: (token: string) => void;
  labels: EditorLabels;
  disabled?: boolean;
};

/** `{{name}}` or `{{name|fallback}}` (the fallback loses braces and bars, which the syntax reserves). */
export function tokenText(name: string, fallback: string): string {
  const clean = fallback.replace(/[{}|]/g, "").trim();
  return clean ? `{{${name}|${clean}}}` : `{{${name}}}`;
}

export function TokenPicker({ mergeFields, onInsert, labels, disabled }: TokenPickerProps) {
  const [open, setOpen] = useState(false);
  const [fallback, setFallback] = useState("");
  const pick = (name: string) => {
    onInsert(tokenText(name, fallback));
    setFallback("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={disabled}>
          {lab(labels, "insert_token")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="grid w-72 gap-3">
        <label className="grid gap-1 text-xs">
          <span>{lab(labels, "token_fallback")}</span>
          <Input value={fallback} onChange={(e) => setFallback(e.target.value)} maxLength={60} />
        </label>
        <div className="grid gap-1">
          <span className="text-xs font-medium">{lab(labels, "tokens")}</span>
          <div className="flex flex-wrap gap-1">
            {EMAIL_TOKENS.map((t) => (
              <Button key={t} type="button" size="sm" variant="secondary" onClick={() => pick(t)}>
                {t}
              </Button>
            ))}
          </div>
        </div>
        {mergeFields.length ? (
          <div className="grid gap-1">
            <span className="text-xs font-medium">{lab(labels, "merge_fields")}</span>
            <div className="flex flex-wrap gap-1">
              {mergeFields.map((t) => (
                <Button key={t} type="button" size="sm" variant="secondary" onClick={() => pick(t)}>
                  {t}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
