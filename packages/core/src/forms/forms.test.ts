import { describe, expect, it } from 'vitest';

import {
  answerText,
  cleanAnswers,
  type FormField,
  fieldIdFor,
  formAnswersError,
  formFieldsError,
  isValidSignature,
  newField,
  signatureViewBox,
  strokesToPath,
  validityLabel,
} from './index.ts';

const consent: FormField[] = [
  {
    id: 'previous_reaction',
    kind: 'choice',
    label: 'Ever reacted to hair dye?',
    required: true,
    options: ['No', 'Yes', 'Not sure'],
  },
  { id: 'details', kind: 'text', label: 'What happened?', multiline: true },
  { id: 'understand', kind: 'checkbox', label: 'I understand the risks', required: true },
  { id: 'photos', kind: 'checkbox', label: 'Photos OK' },
  { id: 'signature', kind: 'signature', label: 'Signature', required: true },
];

const SIG = 'M10 10L20 25L30 12';

describe('formFieldsError', () => {
  it('accepts a valid form', () => {
    expect(formFieldsError(consent)).toBeNull();
  });

  it('needs at least one question', () => {
    expect(formFieldsError([])).toBe('Add at least one question.');
  });

  it('rejects duplicate or malformed ids', () => {
    expect(formFieldsError([consent[1]!, { ...consent[1]!, label: 'Again' }])).toBe(
      'Question 2 needs a unique id.',
    );
    expect(formFieldsError([{ ...consent[1]!, id: 'Has Space' }])).toBe(
      'Question 1 needs a unique id.',
    );
  });

  it('needs a label', () => {
    expect(formFieldsError([{ ...consent[1]!, label: '  ' }])).toBe('Question 1 needs a label.');
  });

  it('checks choices', () => {
    expect(formFieldsError([{ ...consent[0]!, options: ['Only'] }])).toBe(
      'Question 1 needs 2 to 20 choices.',
    );
    expect(formFieldsError([{ ...consent[0]!, options: ['A', 'A'] }])).toBe(
      'Question 1 repeats a choice.',
    );
    expect(formFieldsError([{ ...consent[1]!, options: ['A', 'B'] }])).toBe(
      'Only choice questions have choices.',
    );
  });
});

describe('formAnswersError', () => {
  const good = {
    previous_reaction: 'No',
    understand: true,
    signature: SIG,
  };

  it('accepts complete answers', () => {
    expect(formAnswersError(consent, good)).toBeNull();
    expect(formAnswersError(consent, { ...good, details: 'none', photos: false })).toBeNull();
  });

  it('requires required answers', () => {
    expect(formAnswersError(consent, { ...good, previous_reaction: null })).toBe(
      'Please answer: Ever reacted to hair dye?',
    );
    expect(formAnswersError(consent, { ...good, understand: false })).toBe(
      'Please tick: I understand the risks',
    );
    expect(formAnswersError(consent, { ...good, signature: undefined })).toBe(
      'Please sign: Signature',
    );
  });

  it('rejects answers that do not fit', () => {
    expect(formAnswersError(consent, { ...good, previous_reaction: 'Maybe' })).toBe(
      'Check your answer to: Ever reacted to hair dye?',
    );
    expect(formAnswersError(consent, { ...good, signature: '<svg>' })).toBe(
      'Please sign again: Signature',
    );
    expect(formAnswersError(consent, { ...good, extra: 'x' })).toBe(
      'This form has changed. Reload the page and try again.',
    );
  });
});

describe('signatures', () => {
  it('turns strokes into path data the database accepts', () => {
    const path = strokesToPath([
      [
        { x: 10.4, y: 10.6 },
        { x: 20, y: 25 },
      ],
      [{ x: 5, y: 5 }],
      [],
    ]);
    expect(path).toBe('M10 11L20 25M5 5L6 5');
    expect(isValidSignature(path)).toBe(true);
    expect(signatureViewBox(path)).toBe('-1 -1 27 32');
    expect(signatureViewBox('')).toBe('0 0 100 40');
  });

  it('rejects anything that is not path data', () => {
    expect(isValidSignature('')).toBe(false);
    expect(isValidSignature('M1 1L2 2"/><script>')).toBe(false);
    expect(isValidSignature(42)).toBe(false);
  });
});

describe('builder helpers', () => {
  it('makes unique ids from labels', () => {
    expect(fieldIdFor('Any allergies?', [])).toBe('any_allergies');
    expect(fieldIdFor('Any allergies?', ['any_allergies'])).toBe('any_allergies_2');
    expect(fieldIdFor('!!!', [])).toBe('question');
  });

  it('starts new fields with sensible defaults', () => {
    expect(newField('choice', consent)).toMatchObject({ id: 'choice', options: ['Yes', 'No'] });
    expect(newField('signature', consent)).toMatchObject({
      id: 'signature_2',
      label: 'Signature',
      required: true,
    });
  });

  it('cleans answers before sending', () => {
    expect(
      cleanAnswers(consent, { details: '  ', previous_reaction: 'No', photos: false, x: 'y' }),
    ).toEqual({ previous_reaction: 'No', photos: false });
    expect(cleanAnswers(consent, { details: ' itchy ' })).toEqual({ details: 'itchy' });
  });

  it('labels how long a signature counts', () => {
    expect(validityLabel(null)).toBe('Once');
    expect(validityLabel(0)).toBe('Every visit');
    expect(validityLabel(182)).toBe('Every 6 months');
    expect(validityLabel(30)).toBe('Every 30 days');
  });

  it('shows answers on the profile', () => {
    expect(answerText(consent[2]!, true)).toBe('Yes');
    expect(answerText(consent[3]!, false)).toBe('No');
    expect(answerText(consent[4]!, SIG)).toBe('Signed');
    expect(answerText(consent[1]!, undefined)).toBe('—');
  });
});
