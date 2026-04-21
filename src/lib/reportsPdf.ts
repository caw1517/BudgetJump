import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

const EMERALD: [number, number, number] = [5, 150, 105]
const EMERALD_DARK: [number, number, number] = [4, 120, 87]
const HEADER_H = 28

/** Built-in PDF fonts are WinAnsi; Unicode arrows/dashes often render as garbage (e.g. `!'`). */
const PDF_ARROW = '->'
const PDF_DASH = ' - '

/** Space to leave above the footer band (mm) when deciding to break before a section. */
const PDF_FOOTER_RESERVE_MM = 22

/**
 * Start a new page if there is not enough vertical room for the upcoming block.
 * Uses the real page height so we stay compatible with jspdf-autotable (which also
 * compares against `pageSize().height`); a fixed threshold was too easy to get wrong
 * and could fight autotable's own page logic.
 */
function ensureSpaceForBlock(doc: jsPDF, y: number, blockMinMm: number): number {
  const pageH = doc.internal.pageSize.getHeight()
  const maxStartY = pageH - PDF_FOOTER_RESERVE_MM
  if (y + blockMinMm > maxStartY) {
    doc.addPage()
    return 14
  }
  return y
}

export type ReportsPdfInput = {
  meta: {
    /** Shown in document metadata / future cover subtitle */
    title: string
    from: string
    to: string
    generatedAt: string
    debtAvgMonths: number
  }
  summaryLines: Array<{ label: string; value: string }>
  paycheckAllocations: string[][]
  envelopeMoves: string[][]
  accountTransfers: string[][]
  spendingByEnvelope: string[][]
  debtBreakdown: string[][]
  monthlyTrend: string[][]
  paychecksSummary: string[][]
}

function drawCoverBand(doc: jsPDF, y: number): number {
  doc.setFillColor(...EMERALD)
  doc.rect(0, y, 210, HEADER_H, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(17)
  doc.text('Budget Jump', 14, y + 11)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text('Financial report', 14, y + 18)
  doc.setTextColor(55, 65, 81)
  return y + HEADER_H + 6
}

const PAGE_TEXT_W_MM = 182

function sectionTitle(doc: jsPDF, y: number, title: string): number {
  doc.setTextColor(...EMERALD_DARK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text(title, 14, y)
  doc.setDrawColor(...EMERALD)
  doc.setLineWidth(0.6)
  doc.line(14, y + 1.5, 196, y + 1.5)
  doc.setTextColor(30, 41, 59)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  return y + 8
}

/** Multi-line note under a section title; returns Y after the block. */
function paragraphNote(doc: jsPDF, y: number, text: string): number {
  doc.setFontSize(8)
  doc.setTextColor(100, 116, 139)
  doc.setFont('helvetica', 'normal')
  const lines = doc.splitTextToSize(text, PAGE_TEXT_W_MM)
  doc.text(lines, 14, y)
  return y + Math.max(1, lines.length) * 3.6 + 3
}

/**
 * Stacked label / value blocks (full text width). Avoids side‑by‑side overlap when
 * bold glyphs render wider than splitTextToSize width estimates.
 */
function drawExecutiveSummary(doc: jsPDF, yStart: number, rows: Array<{ label: string; value: string }>): number {
  const x = 14
  const lineHLabel = 4.15
  const lineHValue = 4.35
  let y = yStart
  for (const row of rows) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    const labelLines = doc.splitTextToSize(row.label, PAGE_TEXT_W_MM)
    doc.text(labelLines, x, y, { lineHeightFactor: 1.18 })
    y += labelLines.length * lineHLabel + 0.5
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9.5)
    const valueLines = doc.splitTextToSize(row.value, PAGE_TEXT_W_MM)
    doc.text(valueLines, x, y, { lineHeightFactor: 1.18 })
    y += valueLines.length * lineHValue + 3.2
  }
  return y + 2
}

type TableBlockOpts = {
  foot?: string[][]
  /** Column widths in mm (should sum to ~186 for default margins). */
  columnWidthsMm?: number[]
  compact?: boolean
}

function tableBlock(doc: jsPDF, startY: number, head: string[][], body: string[][], opts?: TableBlockOpts): number {
  if (body.length === 0) {
    doc.setFontSize(9)
    doc.setTextColor(100, 116, 139)
    doc.text('No rows in this period.', 14, startY + 4)
    return startY + 12
  }
  const fs = opts?.compact ? 7 : 8
  const pad = opts?.compact ? 1.1 : 1.5
  const columnStyles: Record<number, { cellWidth: number; overflow: 'linebreak' }> | undefined =
    opts?.columnWidthsMm && opts.columnWidthsMm.length > 0
      ? Object.fromEntries(opts.columnWidthsMm.map((w, i) => [i, { cellWidth: w, overflow: 'linebreak' as const }]))
      : undefined

  autoTable(doc, {
    startY,
    head,
    body,
    foot: opts?.foot && opts.foot.length > 0 ? opts.foot : undefined,
    theme: 'plain',
    styles: {
      fontSize: fs,
      cellPadding: pad,
      textColor: [30, 41, 59],
      lineColor: [226, 232, 240],
      lineWidth: 0.15,
      overflow: 'linebreak',
      valign: 'top',
      minCellHeight: 3.5,
    },
    headStyles: {
      fillColor: EMERALD,
      textColor: 255,
      fontStyle: 'bold',
      halign: 'left',
      fontSize: fs,
    },
    footStyles: { fillColor: [241, 245, 249], textColor: [51, 65, 85], fontStyle: 'bold', fontSize: fs },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    /**
     * Bottom margin so autotable's pagination clears the footer (~287mm).
     * Do not set `top: 0`: when autotable inserts a page it resets `y` to `margin.top`, and 0
     * clips the table off the top of the page (tables look "missing").
     */
    margin: { left: 12, right: 12, bottom: 22 },
    tableLineColor: [226, 232, 240],
    tableLineWidth: 0.1,
    columnStyles,
  })
  const docExt = doc as jsPDF & { lastAutoTable?: { finalY: number } }
  return (docExt.lastAutoTable?.finalY ?? startY) + 10
}

function addFooters(doc: jsPDF) {
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text(`Page ${i} of ${total}`, 196, 287, { align: 'right' })
    doc.text(`Budget Jump${PDF_DASH}Confidential`, 14, 287)
  }
}

/** Truncate for PDF cell width */
export function pdfCell(s: string, max = 42): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

export function downloadReportsPdf(data: ReportsPdfInput): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  let y = 0
  y = drawCoverBand(doc, y)

  doc.setTextColor(71, 85, 105)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const metaLines = doc.splitTextToSize(
    `Period: ${data.meta.from} ${PDF_ARROW} ${data.meta.to}\nGenerated: ${data.meta.generatedAt}\nDebt payoff average: last ${data.meta.debtAvgMonths} months of posted payment transactions.`,
    PAGE_TEXT_W_MM,
  )
  doc.text(metaLines, 14, y)
  y += metaLines.length * 4.6 + 8

  y = ensureSpaceForBlock(doc, y, 36)
  y = sectionTitle(doc, y, 'Executive summary')
  y = drawExecutiveSummary(doc, y, data.summaryLines)

  y = ensureSpaceForBlock(doc, y, 26)
  y = sectionTitle(doc, y, 'Paychecks in period (summary)')
  y = tableBlock(doc, y, [['Date', 'Source', 'Net deposit']], data.paychecksSummary, {
    columnWidthsMm: [22, 100, 64],
  })

  y = ensureSpaceForBlock(doc, y, 48)
  y = sectionTitle(doc, y, `Paycheck ${PDF_ARROW} envelope assignments (detail)`)
  y = paragraphNote(
    doc,
    y,
    'Each row is one allocation line: which paycheck funded which envelope and for which budget month.',
  )
  y = tableBlock(
    doc,
    y,
    [['Paycheck date', 'Source', 'Paycheck net', 'Envelope', 'Assigned', 'Budget month']],
    data.paycheckAllocations,
    { columnWidthsMm: [20, 38, 22, 44, 22, 20] },
  )

  y = ensureSpaceForBlock(doc, y, 26)
  y = sectionTitle(doc, y, 'Envelope-to-envelope moves')
  y = tableBlock(doc, y, [['When', 'From', 'To', 'Amount', 'Reason']], data.envelopeMoves, {
    columnWidthsMm: [26, 40, 40, 22, 58],
  })

  y = ensureSpaceForBlock(doc, y, 40)
  y = sectionTitle(doc, y, 'Account transfers (register)')
  y = paragraphNote(
    doc,
    y,
    'Paired rows are one logical transfer (source outflow, destination inflow). Unmatched lines list account and payee as stored.',
  )
  y = tableBlock(doc, y, [['Date', 'Transfer', 'Amount', 'Note']], data.accountTransfers, {
    columnWidthsMm: [22, 78, 24, 60],
  })

  y = ensureSpaceForBlock(doc, y, 52)
  y = sectionTitle(doc, y, `Debt & cards${PDF_DASH}balances & projected payoff`)
  y = paragraphNote(
    doc,
    y,
    'Projected payoff uses monthly payment = max(minimum, planned, average payment in the window above). Simple monthly interest model; same idea as the in-app Debt tracker.',
  )
  const debtHead = [
    'Account',
    'Balance',
    'APR',
    'Min/mo',
    'Planned',
    `Avg (${data.meta.debtAvgMonths} mo)`,
    'Modeled',
    'Payoff',
    'Notes',
  ]
  y = tableBlock(doc, y, [debtHead], data.debtBreakdown, {
    compact: true,
    // Wider Notes column so wrapped lines (e.g. est. interest) are not clipped.
    columnWidthsMm: [28, 20, 14, 17, 17, 17, 19, 20, 34],
  })

  y = ensureSpaceForBlock(doc, y, 26)
  y = sectionTitle(doc, y, 'Spending by envelope (outflows)')
  y = tableBlock(doc, y, [['Envelope', 'Out', 'Credits', '% of out']], data.spendingByEnvelope, {
    columnWidthsMm: [100, 28, 28, 30],
  })

  y = ensureSpaceForBlock(doc, y, 26)
  y = sectionTitle(doc, y, 'Monthly spending trend')
  y = tableBlock(doc, y, [['Month', 'Outflows', 'Credits']], data.monthlyTrend, {
    columnWidthsMm: [28, 80, 78],
  })

  addFooters(doc)
  doc.save(`budget-jump-report-${data.meta.from}_${data.meta.to}.pdf`)
}
