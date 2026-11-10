/**
 * Intake & consent forms (#45). Mirrors the SQL in
 * supabase/migrations/20261109400000_client_forms.sql (private.valid_form_fields and
 * private.form_answers_error) so the builder and the client's form page catch mistakes before
 * the database does.
 */

export type FormFieldKind = 'text' | 'choice' | 'checkbox' | 'signature';

export interface FormField {
  /** Stable key for the answer: lowercase letters, digits and underscores. */
  id: string;
  kind: FormFieldKind;
  label: string;
  required?: boolean;
  help?: string;
  /** Text only: a bigger box. */
  multiline?: boolean;
  /** Choice only: 2–20 distinct options. */
  options?: string[];
}

/** Answers keyed by field id: text and choice are strings, checkboxes booleans, signatures SVG path data. */
export type FormAnswers = Record<string, string | boolean | null | undefined>;

export const FIELD_KINDS: readonly FormFieldKind[] = ['text', 'choice', 'checkbox', 'signature'];
export const MAX_FIELDS = 40;
export const MAX_LABEL = 300;
export const MAX_HELP = 500;
export const MAX_OPTIONS = 20;
export const MAX_OPTION = 200;
export const MAX_TEXT_ANSWER = 4000;
export const MAX_FORM_NAME = 80;
export const MAX_FORM_DESCRIPTION = 1000;
export const MAX_VALID_DAYS = 3650;
export const MAX_SIGNATURE = 40000;

const FIELD_ID = /^[a-z0-9_]{1,40}$/;
const SIGNATURE = /^M[-0-9MLml .,]+$/;

export const FIELD_KIND_LABELS: Record<FormFieldKind, string> = {
  text: 'Text',
  choice: 'Choice',
  checkbox: 'Checkbox',
  signature: 'Signature',
};

/** Why `fields` can't be saved, or null. */
export function formFieldsError(fields: readonly FormField[]): string | null {
  if (fields.length === 0) return 'Add at least one question.';
  if (fields.length > MAX_FIELDS) return `A form can have up to ${MAX_FIELDS} questions.`;
  const ids = new Set<string>();
  for (const [i, f] of fields.entries()) {
    const n = i + 1;
    if (!FIELD_ID.test(f.id) || ids.has(f.id)) return `Question ${n} needs a unique id.`;
    ids.add(f.id);
    if (!FIELD_KINDS.includes(f.kind)) return `Question ${n} has an unknown type.`;
    const label = f.label.trim();
    if (label.length === 0) return `Question ${n} needs a label.`;
    if (label.length > MAX_LABEL) return `Question ${n} is too long.`;
    if (f.help !== undefined && f.help.length > MAX_HELP)
      return `Question ${n}'s help is too long.`;
    if (f.kind === 'choice') {
      const options = f.options ?? [];
      if (options.length < 2 || options.length > MAX_OPTIONS) {
        return `Question ${n} needs 2 to ${MAX_OPTIONS} choices.`;
      }
      if (options.some((o) => o.trim().length === 0 || o.trim().length > MAX_OPTION)) {
        return `Question ${n} has an empty or too long choice.`;
      }
      if (new Set(options).size !== options.length) return `Question ${n} repeats a choice.`;
    } else if (f.options !== undefined) {
      return `Only choice questions have choices.`;
    }
  }
  return null;
}

export function isValidSignature(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 4 &&
    value.length <= MAX_SIGNATURE &&
    SIGNATURE.test(value)
  );
}

/** Why `answers` can't be submitted for `fields`, or null (same messages as the database). */
export function formAnswersError(
  fields: readonly FormField[],
  answers: FormAnswers,
): string | null {
  const known = new Set(fields.map((f) => f.id));
  if (Object.keys(answers).some((k) => answers[k] !== undefined && !known.has(k))) {
    return 'This form has changed. Reload the page and try again.';
  }
  for (const f of fields) {
    const v = answers[f.id] ?? null;
    const required = f.required === true;
    switch (f.kind) {
      case 'text':
        if (v !== null && (typeof v !== 'string' || v.length > MAX_TEXT_ANSWER)) {
          return `Check your answer to: ${f.label}`;
        }
        if (required && (typeof v !== 'string' || v.trim() === '')) {
          return `Please answer: ${f.label}`;
        }
        break;
      case 'choice':
        if (v !== null && (typeof v !== 'string' || !(f.options ?? []).includes(v))) {
          return `Check your answer to: ${f.label}`;
        }
        if (required && v === null) return `Please answer: ${f.label}`;
        break;
      case 'checkbox':
        if (v !== null && typeof v !== 'boolean') return `Check your answer to: ${f.label}`;
        if (required && v !== true) return `Please tick: ${f.label}`;
        break;
      case 'signature':
        if (v !== null && !isValidSignature(v)) return `Please sign again: ${f.label}`;
        if (required && v === null) return `Please sign: ${f.label}`;
        break;
    }
  }
  return null;
}

/** Drops empty answers and trims text before sending. */
export function cleanAnswers(fields: readonly FormField[], answers: FormAnswers): FormAnswers {
  const out: FormAnswers = {};
  for (const f of fields) {
    const v = answers[f.id];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && f.kind === 'text') {
      if (v.trim() !== '') out[f.id] = v.trim();
      continue;
    }
    out[f.id] = v;
  }
  return out;
}

/** A field id from its label: "Any allergies?" → "any_allergies", unique among `taken`. */
export function fieldIdFor(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'question';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`;
    if (!used.has(id)) return id;
  }
}

/** A new field of `kind` with an id not used in `fields`. */
export function newField(kind: FormFieldKind, fields: readonly FormField[]): FormField {
  const id = fieldIdFor(
    kind,
    fields.map((f) => f.id),
  );
  switch (kind) {
    case 'choice':
      return { id, kind, label: '', required: false, options: ['Yes', 'No'] };
    case 'signature':
      return { id, kind, label: 'Signature', required: true };
    default:
      return { id, kind, label: '', required: false };
  }
}

export const VALIDITY_PRESETS: readonly { label: string; days: number | null }[] = [
  { label: 'Once', days: null },
  { label: 'Every visit', days: 0 },
  { label: 'Every 6 months', days: 182 },
  { label: 'Every year', days: 365 },
];

/** "Once", "Every visit", "Every 6 months"… for valid_days. */
export function validityLabel(validDays: number | null): string {
  const preset = VALIDITY_PRESETS.find((p) => p.days === validDays);
  if (preset) return preset.label;
  return validDays === 1 ? 'Every day' : `Every ${validDays} days`;
}

// --- Signatures ---------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** SVG path data for strokes drawn on the signature pad, rounded to whole pixels. */
export function strokesToPath(strokes: readonly (readonly Point[])[]): string {
  const parts: string[] = [];
  for (const stroke of strokes) {
    const first = stroke[0];
    if (!first) continue;
    const pts = stroke.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`);
    // A tap still shows up: draw a dot as a 1px line.
    if (pts.length === 1) pts.push(`${Math.round(first.x) + 1} ${Math.round(first.y)}`);
    parts.push(`M${pts[0]}L${pts.slice(1).join(' ')}`);
  }
  return parts.join('');
}

/** An SVG viewBox ("x y w h") around a signature's path, with a little padding. */
export function signatureViewBox(path: string, pad = 6): string {
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  if (xs.length === 0 || ys.length === 0) return '0 0 100 40';
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) + pad - minX;
  const h = Math.max(...ys) + pad - minY;
  return `${minX} ${minY} ${Math.max(w, 1)} ${Math.max(h, 1)}`;
}

/** How a submitted answer reads on the profile. */
export function answerText(field: FormField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  switch (field.kind) {
    case 'checkbox':
      return value === true ? 'Yes' : 'No';
    case 'signature':
      return 'Signed';
    default:
      return String(value);
  }
}
