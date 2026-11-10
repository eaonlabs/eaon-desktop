import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { documentFormat, extractDocument } from '../src/main/agent/documents'

/** Attached PDFs and Word documents become text; the files are built here so no fixture is needed. */

const dir = mkdtempSync(join(tmpdir(), 'eaon-documents-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

/** A zip of stored (uncompressed) entries: all a Word file needs to be read back. */
function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const file = Buffer.from(name)
    const data = Buffer.from(text)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(file.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(file.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, file, data)
    centrals.push(central, file)
    offset += local.length + file.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** A one-page PDF with a line of text, its cross-reference table counted out. */
function pdfOf(line: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 18 Tf 20 100 Td (${line}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 20 100 Td (${line}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const at: number[] = []
  objects.forEach((body, i) => {
    at.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

test('the format comes from the file name, and old Office files are not read', () => {
  assert.equal(documentFormat('/a/report.PDF'), 'pdf')
  assert.equal(documentFormat('/a/notes.docx'), 'docx')
  assert.equal(documentFormat('/a/sheet.xlsx'), 'xlsx')
  assert.equal(documentFormat('/a/old.doc'), null)
  assert.equal(documentFormat('/a/old.xls'), null)
  assert.equal(documentFormat('/a/deck.pptx'), null)
})

test('a PDF gives its text, page by page', async () => {
  const file = join(dir, 'hello.pdf')
  writeFileSync(file, pdfOf('Hello from Falcon Hacks'))
  const result = await extractDocument(file)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.format, 'pdf')
    assert.match(result.text, /\[Page 1\]/)
    assert.match(result.text, /Hello from Falcon Hacks/)
    assert.equal(result.cut, false)
  }
})

test('a Word document gives its paragraphs', async () => {
  const file = join(dir, 'notes.docx')
  writeFileSync(
    file,
    zipOf({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'word/document.xml':
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; last</w:t></w:r></w:p></w:body></w:document>'
    })
  )
  const result = await extractDocument(file)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.format, 'docx')
    assert.match(result.text, /First paragraph/)
    assert.match(result.text, /Second & last/)
  }
})

test('a file that is not what its name says is reported, not thrown', async () => {
  const file = join(dir, 'fake.pdf')
  writeFileSync(file, 'this is plain text')
  const result = await extractDocument(file)
  assert.equal(result.ok, false)
})
