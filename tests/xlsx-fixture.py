"""Minimal synthetic OpenXML byte streams for importer tests, not user workbooks."""
import io
import json
import sys
import zipfile
from xml.sax.saxutils import escape, quoteattr

sheets = json.load(sys.stdin)
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1, len(sheets) + 1)) + '</Types>')
    archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + ''.join(f'<sheet name={quoteattr(sheet["name"])} sheetId="{i}" r:id="rId{i}"/>' for i, sheet in enumerate(sheets, 1)) + '</sheets></workbook>')
    archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1)) + '</Relationships>')
    for index, sheet in enumerate(sheets, 1):
        xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        for r, row in enumerate(sheet["rows"], 1):
            xml += f'<row r="{r}">'
            for c, value in enumerate(row):
                ref = chr(65 + c) + str(r)
                if isinstance(value, dict):
                    xml += f'<c r="{ref}"><f>{escape(value["formula"])}</f><v>0</v></c>'
                else:
                    xml += f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'
            xml += '</row>'
        archive.writestr(f'xl/worksheets/sheet{index}.xml', xml + '</sheetData></worksheet>')
sys.stdout.buffer.write(buffer.getvalue())
