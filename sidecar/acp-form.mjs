// ACP elicitation uses a flat, restricted JSON Schema. Normalize it to what
// the editor can show and keep its opaque keys and option values on the wire.
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim() ? v.trim() : undefined;
const count = (n) => Number.isInteger(n) && n >= 0 ? n : undefined;
const number = (n) => Number.isFinite(n) ? n : undefined;
const own = (values, id) => Object.hasOwn(values, id) ? values[id] : undefined;

function choiceOptions(enumerated, titled) {
  if (enumerated != null && titled != null) return undefined;
  const entries = enumerated ?? titled;
  if (!Array.isArray(entries) || !entries.length) return undefined;
  const options = [];
  const seen = new Set();
  for (const entry of entries) {
    const value = enumerated != null ? entry : entry?.const;
    if (typeof value !== "string" || seen.has(value)) return undefined;
    seen.add(value);
    options.push({ value, label: text(entry?.title) ?? (value || '""'), description: text(entry?.description) });
  }
  return options;
}

function parseField(id, property, required) {
  if (!object(property)) return undefined;
  const base = { id, label: text(property.title) ?? id, description: text(property.description), required };
  switch (property.type) {
    case "string": {
      if (property.enum == null && property.oneOf == null) {
        return { ...base, kind: "text", minLength: count(property.minLength), maxLength: count(property.maxLength) };
      }
      const options = choiceOptions(property.enum, property.oneOf);
      return options && { ...base, kind: "choice", options };
    }
    case "array": {
      const items = property.items;
      const options = items && (items.type === undefined || items.type === "string") ? choiceOptions(items.enum, items.anyOf) : undefined;
      const minItems = count(property.minItems);
      const maxItems = count(property.maxItems);
      if (!options || maxItems === 0 || (minItems ?? 0) > Math.min(maxItems ?? Infinity, options.length)) return undefined;
      return { ...base, kind: "multiChoice", options, minItems, maxItems };
    }
    case "boolean":
      return { ...base, kind: "choice", boolean: true, options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
    case "integer":
    case "number":
      return { ...base, kind: "number", integer: property.type === "integer", minimum: number(property.minimum), maximum: number(property.maximum) };
    default:
      return undefined;
  }
}

export function parseAcpForm(schema, { antigravity = false } = {}) {
  if (schema?.type !== "object" || !object(schema.properties)) return undefined;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || !required.every((id) => typeof id === "string" && Object.hasOwn(schema.properties, id))) return undefined;
  const fields = new Map();
  for (const [id, property] of Object.entries(schema.properties)) {
    const field = parseField(id, property, required.includes(id));
    if (!field) {
      if (required.includes(id)) return undefined;
      continue;
    }
    const initial = typeof property.default === "number" || typeof property.default === "boolean" ? String(property.default) : property.default;
    if (typedValue(field, initial) !== undefined) field.initial = initial;
    fields.set(id, field);
  }
  if (!fields.size && Object.keys(schema.properties).length) return undefined;

  // Both wire keys are optional so the agent can accept a choice or free text.
  // agy uses qN_other for both single and multi-choice, and emits q10 before q2.
  const agyQuestion = (id) => antigravity && /^q[1-9]\d*$/.test(id);
  for (const field of fields.values()) {
    if (field.required || (field.kind !== "choice" && field.kind !== "multiChoice") || field.boolean) continue;
    const companionId = agyQuestion(field.id) ? `${field.id}_other` : `${field.id}__other`;
    const other = fields.get(companionId);
    if (other?.kind === "text" && !other.required) {
      field.other = { id: other.id, initial: other.initial, minLength: other.minLength, maxLength: other.maxLength };
      if (agyQuestion(field.id)) field.required = true;
      fields.delete(companionId);
    }
  }
  const questions = [...fields.values()];
  if (questions.every((field) => agyQuestion(field.id))) questions.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return questions;
}

function textValue(field, value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const length = Array.from(value).length;
  return length >= (field.minLength ?? 0) && length <= (field.maxLength ?? Infinity) ? value : undefined;
}

function typedValue(field, value) {
  switch (field.kind) {
    case "text":
      return textValue(field, value);
    case "number": {
      if (typeof value !== "string" || !value.trim()) return undefined;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || (field.integer && !Number.isInteger(parsed))) return undefined;
      return parsed >= (field.minimum ?? -Infinity) && parsed <= (field.maximum ?? Infinity) ? parsed : undefined;
    }
    case "choice":
      if (!field.options.some((option) => option.value === value)) return undefined;
      return field.boolean ? value === "true" : value;
    case "multiChoice":
      if (!Array.isArray(value) || value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? Infinity)) return undefined;
      if (new Set(value).size !== value.length || !value.every((id) => field.options.some((option) => option.value === id))) return undefined;
      return value;
  }
}

/** Shared by the form's Submit button and the bridge that receives its answers. */
export function formContent(fields, answers) {
  if (!object(answers)) return undefined;
  const entries = [];
  for (const field of fields) {
    const raw = own(answers, field.id);
    const isChoice = field.kind === "choice" || field.kind === "multiChoice";
    const blank = raw === undefined || (!isChoice && typeof raw === "string" && !raw.trim());
    const value = typedValue(field, raw);
    if (!blank && value === undefined) return undefined;
    if (value !== undefined) entries.push([field.id, value]);
    let custom;
    if (field.other) {
      const input = own(answers, field.other.id);
      custom = textValue(field.other, input);
      if (custom !== undefined) entries.push([field.other.id, custom]);
      else if (input !== undefined && (typeof input !== "string" || input.trim())) return undefined;
    }
    if (field.required && value === undefined && custom === undefined) return undefined;
  }
  return Object.fromEntries(entries);
}

/** One answer's share of the recorded reply: the option's own label, or the raw entry for free fields. */
export function formOptionLabel(field, value, { yes = "Yes", no = "No" } = {}) {
  if (field.boolean) return value === "true" ? yes : no;
  return field.options?.find((option) => option.value === value)?.label ?? value;
}

/** The answers as the transcript shows them: one "Question: pick, pick" line per field. */
export function formAnswerText(fields, answers, labels) {
  const lines = [];
  for (const field of fields) {
    const parts = [];
    const value = answers?.[field.id];
    if (value !== undefined) for (const entry of Array.isArray(value) ? value : [value]) parts.push(formOptionLabel(field, entry, labels));
    if (field.other) {
      const custom = String(answers?.[field.other.id] ?? "").trim();
      if (custom) parts.push(custom);
    }
    if (parts.length) lines.push(`${field.label}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

const GENERIC_FORM_MESSAGE = /^(?:the agent has \d+ questions?\.?|please answer (?:the )?(?:following )?questions?\.?|answer (?:the )?(?:following )?questions?\.?)$/i;

/** Drops boilerplate count-only ACP messages ("The agent has 2 questions.") and duplicates of the first question. */
export function meaningfulFormMessage(message, title, fields) {
  const clean = typeof message === "string" ? message.trim() : "";
  if (!clean) return "";
  if (GENERIC_FORM_MESSAGE.test(clean)) return "";
  if (typeof title === "string" && clean === title.trim()) return "";
  if (Array.isArray(fields) && fields.length === 1 && clean === String(fields[0]?.label ?? "").trim()) return "";
  return clean;
}
