'use strict';

// Презентация .pptx без установки программ: набор XML-файлов в zip (стандарт Office Open XML).
// Открывается в PowerPoint, LibreOffice и других. Тёмный стиль с акцентом; одна раскладка, без картинок.
const { writeZip, readZip } = require('./zip');

const SLIDE_W = 12192000; // 13,33 дюйма в EMU (914400 на дюйм)
const SLIDE_H = 6858000;
const MARGIN = 640080;
const BG = '0E1116';
const FG = 'F2F4F8';
const MUTED = 'A9B3C4';
const ACCENT = '39FF14';
const MAX_BULLETS = 12;

const esc = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Текстовый блок. paras — готовые <a:p>.
function textBox(id, x, y, cx, cy, paras, anchor = 't') {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Текст ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

// Прямоугольник без текста: полоса-акцент.
function bar(id, x, y, cx, cy, color) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Полоса ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}

function run(text, { size, color, bold = false }) {
  return `<a:r><a:rPr lang="ru-RU" sz="${size}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
    + `<a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t>${esc(text)}</a:t></a:r>`;
}

const titlePara = (text, size, color, algn = 'l') => `<a:p><a:pPr algn="${algn}"><a:buNone/></a:pPr>${run(text, { size, color, bold: true })}</a:p>`;
const bulletPara = (text) => `<a:p><a:pPr marL="342900" indent="-342900"><a:spcBef><a:spcPts val="1400"/></a:spcBef><a:buClr><a:srgbClr val="${ACCENT}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="■"/></a:pPr>${run(text, { size: 2600, color: FG })}</a:p>`;

function slideXml(shapes, bg) {
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    + `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
    + `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`
    + `${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

// Обложка: название по центру, акцентная полоса под ним.
function coverShapes(title) {
  const w = SLIDE_W - MARGIN * 2;
  return bar(2, MARGIN, 3300000, 1600000, 54864, ACCENT)
    + textBox(3, MARGIN, 1900000, w, 1350000, titlePara(title, 6000, FG), 'b')
    + textBox(4, MARGIN, 3500000, w, 900000, '<a:p><a:pPr><a:buNone/></a:pPr></a:p>');
}

// Обычный слайд: заголовок сверху, маркированный список ниже.
function contentShapes(title, bullets) {
  const w = SLIDE_W - MARGIN * 2;
  const size = title.length > 60 ? 3400 : 4400;
  return bar(2, MARGIN, 1520000, 1600000, 45720, ACCENT)
    + textBox(3, MARGIN, 457200, w, 1000000, titlePara(title, size, FG), 'b')
    + textBox(4, MARGIN, 1800000, w, SLIDE_H - 1800000 - 640080, bullets.map(bulletPara).join(''));
}

// Нормализует слайды: заголовок обязателен, список — строки без пустых и без лишних.
function normalizeSlides(slides) {
  return (Array.isArray(slides) ? slides : [])
    .map((s) => ({
      title: String((s && s.title) || '').trim(),
      bullets: (Array.isArray(s && s.bullets) ? s.bullets : []).map((b) => String(b).trim()).filter(Boolean).slice(0, MAX_BULLETS),
    }))
    .filter((s) => s.title || s.bullets.length);
}

// Набор слайдов: обложка (если задано title) и содержательные слайды. Возвращает {slides: [...xml], pages: n}.
function buildPages({ title, slides }) {
  const pages = [];
  const cover = String(title || '').trim();
  if (cover) pages.push({ bg: BG, shapes: coverShapes(cover) });
  for (const s of normalizeSlides(slides)) {
    pages.push({ bg: BG, shapes: contentShapes(s.title || ' ', s.bullets) });
  }
  return pages;
}

const CONTENT_TYPES = (count) => `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
  + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
  + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
  + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
  + Array.from({ length: count }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  + '</Types>';

const rels = (items) => `${XML_HEAD}<Relationships xmlns="${REL_NS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>`;
const REL_SLIDE = `${OFFICE_REL}/slide`;
const REL_LAYOUT = `${OFFICE_REL}/slideLayout`;
const REL_MASTER = `${OFFICE_REL}/slideMaster`;
const REL_THEME = `${OFFICE_REL}/theme`;

// Минимальная тема Office: цвета, шрифты и стили, которых требует PowerPoint.
const THEME = `${XML_HEAD}<a:theme ${NS} name="Nox"><a:themeElements>`
  + '<a:clrScheme name="Nox"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0E1116"/></a:dk2><a:lt2><a:srgbClr val="F2F4F8"/></a:lt2>'
  + `<a:accent1><a:srgbClr val="${ACCENT}"/></a:accent1><a:accent2><a:srgbClr val="2F6FEB"/></a:accent2><a:accent3><a:srgbClr val="FF3D9A"/></a:accent3><a:accent4><a:srgbClr val="FFB020"/></a:accent4><a:accent5><a:srgbClr val="7C5CFF"/></a:accent5><a:accent6><a:srgbClr val="00C2D1"/></a:accent6>`
  + '<a:hlink><a:srgbClr val="2F6FEB"/></a:hlink><a:folHlink><a:srgbClr val="7C5CFF"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Nox"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Nox"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
  + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const MASTER = `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>`
  + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2200"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const LAYOUT = `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Пустой"><p:spTree>`
  + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

// Презентация в виде байтов .pptx. title — обложка (необязательна), slides — [{title, bullets}].
function pptxBuffer({ title, slides } = {}) {
  const pages = buildPages({ title, slides });
  if (!pages.length) throw new Error('нет слайдов: передайте title или slides');
  const n = pages.length;
  const slideIds = pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('');
  const presentation = `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${slideIds}</p:sldIdLst>`
    + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const presentationRels = rels([
    ['rId1', REL_MASTER, 'slideMasters/slideMaster1.xml'],
    ['rId2', REL_THEME, 'theme/theme1.xml'],
    ...pages.map((_, i) => [`rId${i + 3}`, REL_SLIDE, `slides/slide${i + 1}.xml`]),
  ]);
  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES(n) },
    { name: '_rels/.rels', data: rels([['rId1', `${OFFICE_REL}/officeDocument`, 'ppt/presentation.xml']]) },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', REL_LAYOUT, '../slideLayouts/slideLayout1.xml'], ['rId2', REL_THEME, '../theme/theme1.xml']]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', REL_MASTER, '../slideMasters/slideMaster1.xml']]) },
    { name: 'ppt/theme/theme1.xml', data: THEME },
  ];
  pages.forEach((page, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: slideXml(page.shapes, page.bg) });
    entries.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels([['rId1', REL_LAYOUT, '../slideLayouts/slideLayout1.xml']]) });
  });
  return writeZip(entries);
}

// Проверка файла: это архив с презентацией и в нём ровно expected слайдов. {ok, slides, evidence}.
function pptxCheck(buf, expected) {
  let files;
  try {
    files = readZip(buf);
  } catch (err) {
    return { ok: false, slides: 0, evidence: `не архив: ${err.message}` };
  }
  if (!files.has('ppt/presentation.xml') || !files.has('[Content_Types].xml')) return { ok: false, slides: 0, evidence: 'нет частей презентации' };
  const count = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
  const ok = count === expected;
  return { ok, slides: count, evidence: ok ? `слайдов: ${count}` : `слайдов ${count}, ожидалось ${expected}` };
}

module.exports = { pptxBuffer, pptxCheck, buildPages, normalizeSlides };
