import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { isZip, readXlsxRows } from './xlsx';

const workbook = (sheet: string, shared?: string) =>
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="r"><sheets><sheet name="Customers" sheetId="1" r:id="rId7"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/data.xml"/></Relationships>',
    ),
    'xl/worksheets/data.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    ...(shared ? { 'xl/sharedStrings.xml': strToU8(`<sst>${shared}</sst>`) } : {}),
  });

describe('readXlsxRows', () => {
  it('reads shared, inline, rich, numeric and boolean cells by position', () => {
    const bytes = workbook(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Opt-in</t></is></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>46359.375</v></c><c r="D3" t="b"><v>1</v></c></row>',
      '<si><t>Name</t></si><si><t>First Visit</t></si><si><r><t>Avery </t></r><r><t xml:space="preserve">&amp; Co</t></r><rPh><t>x</t></rPh></si>',
    );
    expect(isZip(bytes)).toBe(true);
    expect(readXlsxRows(bytes)).toEqual([
      ['Name', 'First Visit', '', 'Opt-in'],
      [],
      ['Avery & Co', '46359.375', '', 'TRUE'],
    ]);
  });

  it('rejects bytes that are not a workbook', () => {
    const csv = strToU8('Name,Phone\n');
    expect(isZip(csv)).toBe(false);
    expect(() => readXlsxRows(csv)).toThrow(/Excel workbook/);
  });
});
