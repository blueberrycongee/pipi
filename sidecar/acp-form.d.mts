import type { FormContent, FormField, FormValues } from "../pi/protocol";

export function formContent(fields: readonly FormField[], answers: FormValues): FormContent | undefined;
export function formOptionLabel(field: FormField, value: string, labels?: { yes?: string; no?: string }): string;
export function formAnswerText(fields: readonly FormField[], answers: FormValues, labels?: { yes?: string; no?: string }): string;
