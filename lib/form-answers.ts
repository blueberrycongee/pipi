import { formAnswerText as acpFormAnswerText, formOptionLabel as acpFormOptionLabel } from "../sidecar/acp-form.mjs";
import { tr } from "./i18n";
import type { FormField, FormValues } from "../pi/protocol";

const labels = () => ({ yes: tr("Yes", "是"), no: tr("No", "否") });

/** One answer's share of the recorded reply: the option's own label, or the raw entry for free fields. */
export function formOptionLabel(field: FormField, value: string): string {
  return acpFormOptionLabel(field, value, labels());
}

/** The answers as the transcript shows them: one "Question: pick, pick" line per field. */
export function formAnswerText(fields: FormField[], values: FormValues): string {
  return acpFormAnswerText(fields, values, labels());
}
