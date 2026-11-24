import { msg } from '../../i18n/messages'
/**
 * "Find scores" (DECISIONS L14, L15): where to get MusicXML, how to make it from a PDF, what it is and
 * why it is the only format. Opened from beside Add score, and from a failed import. Pictures carry
 * it; the words are a headline and a line each. Only sites that were checked and offer MusicXML are
 * listed; no prices, counts or limits, which go stale.
 */
import { Sheet } from '../../ui/controls'
import { Icon } from '../../ui/icons'
import { notePaths, openingNotes, type Opening } from '../../ui/noteDrawing'
import { CopyButton } from '../shared/CopyButton'
import { FileButton } from './FileButton'
import { ENGRAVED_NOTES, ENGRAVING, OPENINGS } from './guideDrawings'
import type { Tile } from './openings'
import styles from './findScores.module.css'

export function FindScoresSheet({
  open,
  accept,
  disabled,
  onClose,
  onFile,
}: {
  open: boolean
  accept: string | undefined
  disabled: boolean
  onClose: () => void
  onFile: (file: File) => void
}) {
  return (
    <Sheet title={msg('Find scores')} open={open} onClose={onClose} tall flush untitled className={styles.dialog}>
      <div class={styles.scroll}>
        <header class={styles.hero}>
          <h2>{msg('Find your next piece')}</h2>
          <p>{msg('Thousands of scores are one download away.')}</p>
          <div class={styles.heroMusic} aria-hidden="true">
            <Roll class={styles.heroRoll} />
            <Roll class={styles.heroPlayed} />
          </div>
        </header>

        <section class={styles.section} aria-labelledby="find-scores-sites">
          <h3 id="find-scores-sites">{msg('Pick a place to look')}</h3>
          <ul class={styles.sites}>
            <Site
              name="Noctave"
              href="https://noctavepiano.com/en/sheet-music/"
              tag={msg('Free')}
              text={msg('Piano pieces for every level, beginners first.')}
              tile="sand"
              opening={OPENINGS.furElise}
            />
            <Site
              name="MuseTrainer"
              href="https://musetrainer.github.io/library/"
              tag={msg('Free')}
              text={msg('Well-known public-domain pieces, one tap to download.')}
              tile="clay"
              opening={OPENINGS.entertainer}
            />
            <Site
              name="MuseScore.com"
              href="https://musescore.com/sheetmusic"
              tag={msg('Free account')}
              text={msg('A huge library. Public-domain and original scores are free.')}
              tile="fern"
              opening={OPENINGS.canon}
            />
            <Site
              name="musicxml.com"
              href="https://www.musicxml.com/music-in-musicxml/"
              tag={msg('More sites')}
              text={msg('A long list of places to look, for every instrument.')}
              tile="wheat"
              opening={OPENINGS.nocturne}
            />
          </ul>
          <p class={styles.tip}>{msg('Choose MusicXML when you download, not PDF.')}</p>
        </section>

        <section class={styles.pdf} aria-labelledby="find-scores-pdf">
          <div class={styles.pdfText}>
            <h3 id="find-scores-pdf">{msg('Only have a PDF?')}</h3>
            <p>{msg('Ask an AI assistant to turn it into MusicXML. Use a frontier model:')}</p>
            <ul class={styles.models}>
              <li>
                <strong>Claude</strong> {msg('{0} or {1}', 'Opus', 'Fable')}
              </li>
              <li>
                <strong>ChatGPT</strong> {msg('{0} or {1}', 'Astra', 'Sol')}
              </li>
            </ul>
            <p class={styles.caution}>
              <Icon name="alert" size={20} />
              <span>{msg('It can misread notes. Compare the result with your PDF.')}</span>
            </p>
            <p class={styles.caution}>
              <Icon name="upload" size={20} />
              <span>{msg('The PDF goes to that service, not to Pianissimo.')}</span>
            </p>
          </div>
          <div class={styles.chat}>
            <div class={styles.attachment} aria-hidden="true">
              <Page />
              <span>PDF</span>
            </div>
            <div class={styles.bubble}>
              <blockquote>{pdfRequest()}</blockquote>
              <CopyButton text={pdfRequest} label={msg('Copy request')} copiedLabel={msg('Request copied')} />
            </div>
            <div class={styles.reply} aria-hidden="true">
              <Roll class={styles.replyRoll} to={0.53} />
              <span>.musicxml</span>
            </div>
          </div>
        </section>

        <section class={styles.section} aria-labelledby="find-scores-what">
          <h3 id="find-scores-what">{msg('What is MusicXML?')}</h3>
          <div class={styles.known}>
            <div class={styles.paper} aria-hidden="true">
              <Engraving hands />
              <Roll class={styles.knownRoll} from={0} height={72} />
            </div>
            <p>
              <strong>{msg('Sheet music that knows its own notes.')}</strong>{' '}
              {msg('An open format that hundreds of music programs can save: .musicxml, .mxl or .xml.')}
            </p>
          </div>
        </section>

        <section class={styles.section} aria-labelledby="find-scores-why">
          <h3 id="find-scores-why">{msg('Why only MusicXML?')}</h3>
          <div class={styles.reasons}>
            <div class={styles.reason} data-tile="clay">
              <div class={styles.photo} aria-hidden="true">
                <Engraving />
              </div>
              <h4>{msg('A PDF or photo is only a picture')}</h4>
              <p>{msg('Pianissimo would have to guess the notes, and mark you wrong when it guessed wrong.')}</p>
            </div>
            <div class={styles.reason} data-tile="sand">
              <div class={styles.midi} aria-hidden="true">
                <Roll class={styles.midiRoll} to={0.81} />
              </div>
              <h4>{msg('A MIDI file has no page')}</h4>
              <p>{msg('It has the notes, but not the notation you are here to read.')}</p>
            </div>
          </div>
        </section>

        <footer class={styles.footer}>
          <p>{msg('Got your file?')}</p>
          <FileButton variant="primary" icon="plus" accept={accept} disabled={disabled} onFile={onFile}>
            {msg('Add score')}
          </FileButton>
        </footer>
      </div>
    </Sheet>
  )
}

/**
 * What to ask for: the structure the importer reads without questions (one part, two staves, a tempo),
 * and a review of the result, which is when an assistant catches most of its mistakes (L15).
 */
function pdfRequest(): string {
  return msg(
    'Turn this piano score into a MusicXML file (.musicxml) that I can download. Use one piano part with two staves: right hand on the upper staff, left hand on the lower. Keep every note, rest, tie, accidental, repeat, key and time signature, and give the tempo in beats per minute. When you finish, review your work: compare the file with the PDF bar by bar and fix every mistake you find. Then tell me which bars you are still unsure about.',
  )
}

function Site({
  name,
  href,
  tag,
  text,
  tile,
  opening,
}: {
  name: string
  href: string
  tag: string
  text: string
  tile: Tile
  opening: Opening
}) {
  const paths = notePaths(openingNotes(opening, 60), { width: 440, height: 72, thickness: 7, shortest: 4 })
  return (
    <li>
      <a class={styles.site} data-tile={tile} href={href} target="_blank" rel="noopener">
        <span class={styles.siteTop}>
          <strong>{name}</strong>
          <span class={styles.tag}>{tag}</span>
          <Icon name="forward" size={20} />
        </span>
        <span class={styles.siteText}>{text}</span>
        <svg class={styles.siteMusic} viewBox="0 0 440 72" preserveAspectRatio="none" aria-hidden="true">
          <path class={styles.rightHand} d={paths.right} />
          <path class={styles.leftHand} d={paths.left} />
        </svg>
      </a>
    </li>
  )
}

const ENGRAVING_WIDTH = 812
const ENGRAVING_HEIGHT = 155

/** The same bars on paper; with `hands`, each hand in the color it has on the score. */
function Engraving({ hands }: { hands?: boolean }) {
  return (
    <svg
      class={styles.engraving}
      data-hands={hands || undefined}
      viewBox={`0 0 ${ENGRAVING_WIDTH} ${ENGRAVING_HEIGHT}`}
      aria-hidden="true"
    >
      <path class={styles.staffLines} d={ENGRAVING.lines} />
      <path d={ENGRAVING.ink} />
      <path class={styles.engravedRight} d={ENGRAVING.right} />
      <path class={`${styles.engravedRight} ${styles.stems}`} d={ENGRAVING.stemsR} />
      <path class={styles.engravedLeft} d={ENGRAVING.left} />
    </svg>
  )
}

/** Where the first note begins: the clefs and the time signature are before it. */
const FIRST_NOTE = 0.106

/** The notes of those bars between two fractions of the width; from 0, each under its notehead. */
function Roll({
  class: className,
  from = FIRST_NOTE,
  to = 1,
  height = 104,
}: {
  class: string | undefined
  from?: number
  to?: number
  height?: number
}) {
  const paths = notePaths(
    ENGRAVED_NOTES.filter((n) => n.to <= to),
    { width: ENGRAVING_WIDTH, height, thickness: 12, shortest: 4 },
  )
  const x = from * ENGRAVING_WIDTH
  return (
    <svg class={className} viewBox={`${x} 0 ${to * ENGRAVING_WIDTH - x} ${height}`} aria-hidden="true">
      <path class={styles.rightHand} d={paths.right} />
      <path class={styles.leftHand} d={paths.left} />
    </svg>
  )
}

/** A sheet of paper: the engraving, small, three times over. */
function Page() {
  return (
    <span class={styles.sheetOfPaper}>
      <Engraving />
      <Engraving />
      <Engraving />
    </span>
  )
}
