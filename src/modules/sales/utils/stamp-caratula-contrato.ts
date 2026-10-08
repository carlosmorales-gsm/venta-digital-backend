/**
 * Sella un folio sobre PDFs generados con jsPDF (fuentes estándar).
 * Coordenadas = origen arriba-izquierda en pt, igual que el front.
 */
import { DocumentKind } from '../enums/document-kind.enum';

export type PdfTextStamp = {
  pageIndex: number;
  x: number;
  y: number;
  boxTop: number;
  boxH: number;
  maxW: number;
  fontSize: number;
};

/** Huecos de “contrato / N° de contrato” en cada PDF de firma. */
export const CONTRATO_STAMPS: Partial<Record<DocumentKind, PdfTextStamp>> = {
  [DocumentKind.CARATULA]: {
    pageIndex: 0,
    x: 465,
    y: 100,
    boxTop: 87.4,
    boxH: 20.8,
    maxW: 108,
    fontSize: 8,
  },
  [DocumentKind.CARTA_AUTORIZACION]: {
    pageIndex: 0,
    x: 382,
    y: 112.5,
    boxTop: 100,
    boxH: 18,
    maxW: 176,
    fontSize: 8,
  },
  [DocumentKind.REGLAMENTO_PARQUE]: {
    pageIndex: 0,
    x: 204,
    y: 543,
    boxTop: 530,
    boxH: 16,
    maxW: 348,
    fontSize: 11,
  },
  [DocumentKind.REGLAMENTO_FOLLETO]: {
    pageIndex: 0,
    x: 76,
    y: 138,
    boxTop: 126,
    boxH: 14,
    maxW: 180,
    fontSize: 7,
  },
  [DocumentKind.CARTA_EXCLUSIONES]: {
    pageIndex: 0,
    x: 440,
    y: 62,
    boxTop: 50,
    boxH: 14,
    maxW: 118,
    fontSize: 8.5,
  },
  [DocumentKind.CARTA_NOMINA]: {
    pageIndex: 0,
    x: 440,
    y: 98,
    boxTop: 86,
    boxH: 14,
    maxW: 118,
    fontSize: 9,
  },
  [DocumentKind.CARTA_FACTURA]: {
    pageIndex: 0,
    x: 100,
    y: 74,
    boxTop: 62,
    boxH: 16,
    maxW: 120,
    fontSize: 9,
  },
  [DocumentKind.CARTA_NO_FACTURA]: {
    pageIndex: 0,
    x: 100,
    y: 74,
    boxTop: 62,
    boxH: 16,
    maxW: 120,
    fontSize: 9,
  },
};

const DEFAULT_PAGE_H = 1009.13;

function extractDict(objRaw: string): string {
  const start = objRaw.indexOf('<<');
  if (start < 0) throw new Error('Objeto PDF sin diccionario');
  let depth = 0;
  for (let i = start; i < objRaw.length - 1; i++) {
    if (objRaw[i] === '<' && objRaw[i + 1] === '<') {
      depth += 1;
      i += 1;
    } else if (objRaw[i] === '>' && objRaw[i + 1] === '>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return objRaw.slice(start, i + 1);
    }
  }
  throw new Error('Diccionario PDF sin cierre');
}

function findObjectRaw(pdf: string, num: number): string {
  const re = new RegExp(`(?:^|[\\r\\n])${num} 0 obj`);
  const m = re.exec(pdf);
  if (!m) throw new Error(`No está el objeto PDF ${num}`);
  const start = pdf.indexOf(`${num} 0 obj`, m.index);
  const end = pdf.indexOf('endobj', start);
  if (end < 0) throw new Error(`Objeto PDF ${num} incompleto`);
  return pdf.slice(start, end + 6);
}

function parseTrailer(pdf: string): {
  size: number;
  root: string;
  startxref: number;
} {
  const sx = pdf.lastIndexOf('startxref');
  if (sx < 0) throw new Error('PDF sin startxref');
  const xrefOff = /startxref\s+(\d+)/.exec(pdf.slice(sx));
  if (!xrefOff) throw new Error('PDF startxref inválido');
  const trailerIdx = pdf.lastIndexOf('trailer', sx);
  if (trailerIdx < 0) {
    throw new Error('PDF sin trailer (no es el formato de jsPDF)');
  }
  const trailer = pdf.slice(trailerIdx, sx);
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)?.[1]);
  const root = /\/Root\s+(\d+\s+0\s+R)/.exec(trailer)?.[1];
  if (!size || !root) throw new Error('Trailer PDF incompleto');
  return { size, root, startxref: Number(xrefOff[1]) };
}

function pageObjectNum(
  pdf: string,
  rootRef: string,
  pageIndex: number,
): number {
  const rootNum = Number(/^(\d+)/.exec(rootRef)?.[1]);
  const catalog = findObjectRaw(pdf, rootNum);
  const pagesNum = Number(/\/Pages\s+(\d+)\s+0\s+R/.exec(catalog)?.[1]);
  if (!pagesNum) throw new Error('Catalog sin Pages');
  const pages = findObjectRaw(pdf, pagesNum);
  const kids = /\/Kids\s*\[([^\]]+)\]/.exec(pages)?.[1];
  const nums = [...(kids ?? '').matchAll(/(\d+)\s+0\s+R/g)].map((m) =>
    Number(m[1]),
  );
  const pageNum = nums[pageIndex];
  if (!pageNum) throw new Error(`PDF sin página ${pageIndex + 1}`);
  return pageNum;
}

function pageHeight(pageDict: string): number {
  const m = /\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s*\]/.exec(
    pageDict,
  );
  return m ? Number(m[1]) : DEFAULT_PAGE_H;
}

function addFontToDict(dict: string, fontRef: string): string {
  if (/\/VdC\s+\d+\s+0\s+R/.test(dict)) return dict;
  if (/\/Font\s*<</.test(dict)) {
    return dict.replace(/\/Font\s*<</, `/Font << /VdC ${fontRef} `);
  }
  return dict.replace(/<</, `<< /Font << /VdC ${fontRef} >> `);
}

function addNamedFont(fontDict: string, fontRef: string): string {
  if (/\/VdC\s+\d+\s+0\s+R/.test(fontDict)) return fontDict;
  return fontDict.replace(/<</, `<< /VdC ${fontRef} `);
}

/** Inyecta /VdC en Resources, aunque vengan como referencia (jsPDF 3/4). */
function injectFontResource(
  pdf: string,
  pageDict: string,
  fontRef: string,
): { pageDict: string; rewritten: { num: number; dict: string }[] } {
  const rewritten: { num: number; dict: string }[] = [];
  const resourcesRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(pageDict);

  if (!resourcesRef) {
    return { pageDict: addFontToDict(pageDict, fontRef), rewritten };
  }

  const resourcesNum = Number(resourcesRef[1]);
  const resourcesRaw = findObjectRaw(pdf, resourcesNum);
  let resourcesDict = extractDict(resourcesRaw);
  const fontRefMatch = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);

  if (fontRefMatch) {
    const fontDictNum = Number(fontRefMatch[1]);
    const fontDictRaw = findObjectRaw(pdf, fontDictNum);
    rewritten.push({
      num: fontDictNum,
      dict: addNamedFont(extractDict(fontDictRaw), fontRef),
    });
    return { pageDict, rewritten };
  }

  rewritten.push({
    num: resourcesNum,
    dict: addFontToDict(resourcesDict, fontRef),
  });
  return { pageDict, rewritten };
}

function appendContents(pageDict: string, streamRef: string): string {
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(pageDict);
  if (arr) {
    return pageDict.replace(arr[0], `/Contents [${arr[1].trim()} ${streamRef}]`);
  }
  const single = /\/Contents\s+(\d+\s+0\s+R)/.exec(pageDict);
  if (single) {
    return pageDict.replace(single[0], `/Contents [${single[1]} ${streamRef}]`);
  }
  return pageDict.replace(/<</, `<< /Contents ${streamRef} `);
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function xrefEntry(offset: number): string {
  return `${String(offset).padStart(10, '0')} 00000 n \n`;
}

function stampOperators(folio: string, pageH: number, box: PdfTextStamp): string {
  const valueY = pageH - box.y;
  const rectY = pageH - (box.boxTop + box.boxH) + 0.6;
  const clipped = folio.slice(0, 24);
  return [
    'q',
    '0.980 0.988 0.992 rg',
    `${box.x - 2} ${rectY} ${box.maxW + 8} ${box.boxH - 1.2} re`,
    'f',
    'Q',
    'BT',
    `/VdC ${box.fontSize} Tf`,
    '0.102 0.133 0.165 rg',
    `${box.x} ${valueY} Td`,
    `(${escapePdfString(clipped)}) Tj`,
    'ET',
    '',
  ].join('\n');
}

function objectBody(num: number, dict: string): string {
  return `${num} 0 obj\n${dict}\nendobj\n`;
}

/** Escribe texto en un hueco de un PDF jsPDF (página y caja dadas). */
export function stampTextOnPdf(
  pdfBytes: Buffer,
  text: string,
  box: PdfTextStamp,
): Buffer {
  const folio = text.trim();
  if (!folio) return pdfBytes;

  const pdf = pdfBytes.toString('latin1');
  const { size, root, startxref } = parseTrailer(pdf);
  const pageNum = pageObjectNum(pdf, root, box.pageIndex);
  const pageRaw = findObjectRaw(pdf, pageNum);
  let pageDict = appendContents(extractDict(pageRaw), `${size + 1} 0 R`);
  const injected = injectFontResource(pdf, pageDict, `${size} 0 R`);
  pageDict = injected.pageDict;
  const pageH = pageHeight(pageDict);
  const ops = stampOperators(folio, pageH, box);

  const parts: { num: number; body: string }[] = [
    ...injected.rewritten.map((item) => ({
      num: item.num,
      body: objectBody(item.num, item.dict),
    })),
    { num: pageNum, body: objectBody(pageNum, pageDict) },
    {
      num: size,
      body:
        `${size} 0 obj\n` +
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n' +
        'endobj\n',
    },
    {
      num: size + 1,
      body:
        `${size + 1} 0 obj\n` +
        `<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\n` +
        `stream\n${ops}endstream\n` +
        'endobj\n',
    },
  ];

  const chunks: Buffer[] = [pdfBytes];
  if (pdfBytes[pdfBytes.length - 1] !== 0x0a) {
    chunks.push(Buffer.from('\n', 'latin1'));
  }
  let offset = chunks.reduce((n, c) => n + c.length, 0);
  const xrefItems: { num: number; offset: number }[] = [];
  const bodies: string[] = [];
  for (const part of parts) {
    xrefItems.push({ num: part.num, offset });
    bodies.push(part.body);
    offset += Buffer.byteLength(part.body, 'latin1');
  }

  let xref = 'xref\n0 1\n0000000000 65535 f \n';
  for (const item of xrefItems.sort((a, b) => a.num - b.num)) {
    xref += `${item.num} 1\n${xrefEntry(item.offset)}`;
  }

  const trailer =
    `trailer\n<< /Size ${size + 2} /Root ${root} /Prev ${startxref} >>\n` +
    `startxref\n${offset}\n%%EOF\n`;

  chunks.push(Buffer.from(bodies.join('') + xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

/** Folio CONTRATO en la carátula (hueco de sale-pdf.ts). */
export function stampContratoOnCaratulaPdf(
  pdfBytes: Buffer,
  contrato: string,
): Buffer {
  return stampTextOnPdf(
    pdfBytes,
    contrato,
    CONTRATO_STAMPS[DocumentKind.CARATULA]!,
  );
}
