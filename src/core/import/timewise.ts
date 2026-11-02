/**
 * score-timewise → score-partwise, the same transposition the MusicXML-supplied XSLT performs:
 * `<measure><part>…</part></measure>` becomes `<part><measure>…</measure></part>`. Header
 * elements are kept; measure attributes move to each part's copy of the measure. Parts are
 * ordered by the part-list, then by first appearance. This is lossless for music data, so it
 * is done rather than refused.
 */
import type { DiagnosticSink } from './diagnostics'
import { attr, childrenNamed, child, el, isElement, type XmlElement, type XmlNode } from './xml'

export function timewiseToPartwise(root: XmlElement, diag: DiagnosticSink): XmlElement {
  const header: XmlNode[] = []
  const measures: XmlElement[] = []
  for (const c of root.children) {
    if (!isElement(c)) continue
    if (c.name === 'measure') measures.push(c)
    else header.push(c)
  }
  const partList = child(root, 'part-list')
  const order: string[] = partList ? childrenNamed(partList, 'score-part').map((sp) => attr(sp, 'id') ?? '') : []
  const byPart = new Map<string, XmlElement[]>()
  for (const id of order) byPart.set(id, [])
  measures.forEach((m, mi) => {
    for (const p of childrenNamed(m, 'part')) {
      const id = attr(p, 'id') ?? ''
      let list = byPart.get(id)
      if (!list) {
        list = []
        byPart.set(id, list)
      }
      while (list.length < mi) {
        diag.warn(
          'timewise-missing-measure',
          `Part “${id}” has no content in timewise measure ${mi + 1}. An empty measure was inserted.`,
        )
        const src = measures[list.length]
        list.push(el('measure', src ? { ...src.attrs } : {}))
      }
      list.push({ name: 'measure', attrs: { ...m.attrs }, children: p.children })
    }
  })
  const parts: XmlElement[] = []
  for (const [id, list] of byPart) {
    if (list.length === 0) continue
    parts.push(el('part', { id }, list))
  }
  diag.info('timewise-converted', 'The timewise score was converted to part-by-part order for import.')
  return { name: 'score-partwise', attrs: { ...root.attrs }, children: [...header, ...parts] }
}
