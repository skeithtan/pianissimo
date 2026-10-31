# Pianissimo app specification Draft

Pianissimo helps a pianist learn to read notation by playing a connected MIDI piano. It presents imported MusicXML music as a continuous horizontal grand staff, waits for the correct pitches, and offers progressively more explicit help when the player gets stuck.

This is the proposed first-release specification. The requested features, free GitHub Pages hosting with no server application, and the prohibition on developing a companion app or publishing through the App Store are requirements. Defaults and implementation choices below are recommendations for review. Target environments are the reference tablet running a current iPadOS with MIDIWeb Browser, and computers running standard desktop Chrome. Working title: Pianissimo.

## Delivery and device compatibility

Deliver Pianissimo as a static HTTPS web application hosted on GitHub Pages using free hosting. No server application is permitted: all score import, parsing, rendering, playback, MIDI handling, and practice storage must run in the user's browser. Do not introduce a remote conversion API, serverless function, or score-processing service. Build tools may produce the site's static assets; they must not become a service for processing user imports. GitHub Pages serves static HTML, CSS, JavaScript, and supporting assets; GitHub Free supports Pages from public repositories. [GitHub Pages hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).

When Pianissimo runs on a computer with the piano connected to that computer, use standard desktop Chrome and its Web MIDI support. No specialist browser is required on the computer. Request MIDI access through the browser's permission flow, detect unavailable or denied access, and provide a clear connection status. [Chrome Web MIDI permissions](https://developer.chrome.com/blog/web-midi-permission-prompt).

On the iPad, using MIDIWeb Browser is accepted. Safari does not currently expose the Web MIDI API required for live input, and a Home Screen shortcut does not add it. MIDIWeb's French App Store listing offers a free download with in-app purchases and requires iPadOS 17.6 or later. Its suitability must be demonstrated on the actual piano without requiring a paid feature. Do not build or distribute a native companion, native wrapper, or App Store listing. [Web MIDI compatibility data](https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json), [MIDIWeb Browser listing](https://apps.apple.com/fr/app/midiweb-browser/id6757226617).

The test target is a current iPadOS release on an older tablet with a touch screen; retain that device and OS as the test target.

Support two intended input routes: USB MIDI, including a MIDI interface for a piano with traditional MIDI sockets; and Bluetooth LE MIDI. Bluetooth audio alone is insufficient. [Apple instrument connection guidance](https://support.apple.com/en-ge/guide/logicpro-ipad/lpip26513101/ipados).

Before building the main application, verify MIDI input and audible MIDI output on the actual piano in desktop Chrome and MIDIWeb on the target iPad. Test USB and Bluetooth independently: note attacks and releases, velocity, pedals, output scheduling and cancellation, same-pitch overlap, playback echo, file import, storage, and reconnection. Receiving notes does not prove that the piano can receive and sound app-generated notes. Use browser- or operating-system-owned pairing instructions and feature detection; do not require website-triggered Bluetooth pairing.

If MIDIWeb cannot pass these checks and no acceptable existing browser does, live MIDI on the specified iPad remains blocked under the current constraints. Desktop Chrome remains a separate supported target subject to its own tests. Safari can still offer score viewing and reference playback. Neither a native component nor a server application is an allowed fallback.

## Main user journey

1. Open the web app and import a MusicXML score.

2. Confirm the piece or movement, left-hand and right-hand parts, and reference tempo.

3. Connect the piano. Test key and pedal input, then use a short playback test to confirm that the app can make the piano sound.

4. Choose which hands you play: both, right, left, or neither for Preview. The connected piano plays the parts assigned to the app.

5. Practice the whole piece or select a passage.

6. Read the next notes indicated on the score and play them. Correct notes advance the strip; wrong notes produce conspicuous feedback.

7. Request note names or the keyboard guide when needed.

8. Repeat a passage and compare completed attempts.

The first version needs four main views: Library and Import, Connection and Pedal Setup, Practice, and Passage Results. Suggested practice appears within Library and Passage Results. Settings open without losing the selected score or passage.

## Practice screen

Use landscape as the primary layout, with a usable portrait layout. Both staves remain vertically aligned in one continuous horizontal strip. There are no page turns or system jumps during practice.

A strong vertical cursor identifies the next onset across the grand staff. Keep it approximately one-third of the way across the viewport and scroll the music beneath it, leaving substantial space to read ahead. At the beginning and end, preserve context without requiring empty score padding.

The header contains the piece name, connection status, hand selector including Preview (neither hand), tempo control showing the speed multiplier and effective BPM with its beat unit, and a compact Labels control with Off, All notes, and Conditional choices. The main area contains the notation, measure numbers, current-note highlights, and loop selection. A compact footer contains Start or Pause, Listen, Repeat, Hint, Show keys, and Settings. Touch controls must be comfortable to use from a piano bench.

Keep clef, key signature, and current meter available at the viewport edge when their original symbols scroll away. Pinch zoom changes notation size; it does not change musical timing. Keep the current event visible when zooming.

Touch dragging allows score inspection while paused. Seeking or changing a loop during an active attempt interrupts that attempt. It never creates a successful result. Provide a Return to current position control when browsing.

Reserve space for note labels so persistent score labels and temporary hints do not cover neighboring notes or abruptly reflow the music when revealed. Label layout may increase spacing between events while preserving alignment between staves and the current musical position. The keyboard guide opens in a bottom panel while retaining the current notation.

## MusicXML score import

MusicXML is the only supported score import format. Accept .musicxml and compressed .mxl files through the browser's local file picker on iPad and computer. Also accept .xml files when their contents identify a MusicXML score; reject unrelated XML with a clear explanation. Parse these files directly in the browser without uploading them to a server.

If an import contains several scores or movements, let the user select one. Malformed XML, damaged compressed files, and unsupported score structures must produce readable diagnostics.

Show an import summary with the score preview, selected piano parts, hand assignments, numerical tempo, and any missing or unsupported information. Check pitches and octaves, ottava markings and their scope, durations, chords, rests, ties, tuplets, staff and voice structure, repeats, and tempo changes before enabling scored practice. A format's ability to represent a feature does not guarantee that an exported file contains it. Ambiguous hand assignments require confirmation; missing numerical tempo requires a practice tempo. [MusicXML score and notation structure](https://www.w3.org/2021/06/musicxml40/tutorial/notation-basics/).

Retain the original MusicXML source and its packaging locally. The import pipeline produces a structured musical model, engraved notation, and a playback representation entirely in the browser. Rendering a readable score alone does not establish that its notes, timing, or hand assignments are correct.

The initial supported musical scope is two-hand, twelve-tone piano music: notes, block chords, marked rolled chords (arpeggios), rests, ties, dotted rhythms, tuplets, pickups, multiple voices, explicit tempo changes, meter and key changes, clef changes, basic dynamics, and pedal markings. Support ordinary repeats and alternative endings only with verified performance-order mapping.

Unfold written repeats into a linear performance order for the strip. Preserve printed bar numbers and identify repeat occurrences, such as “bar 12, pass 2.” User-created practice loops are separate from repeats written in the music. [MusicXML repeat instructions](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/repeat/).

Confirm hand assignments from staff and voice information. Do not infer hands from pitch, a middle-C split, or clef alone. Cross-staff passages require an explicit assignment. MIDI input does not reveal which physical hand played a key.

When ornaments, grace notes, tremolo shorthand, microtones, free time, or custom musical logic cannot be interpreted reliably, identify the affected passage. Allow viewing where possible, but disable scored practice there until its interpretation is defined. Do not silently drop notes.

A numerical tempo must include its beat unit. If the source has no numerical tempo, request a practice tempo before timing or playback. A verbal tempo, fermata, or “rit.” marking does not supply an exact duration by itself. For MusicXML, normalize playback tempo and printed metronome markings to the same tempo map: the sound tempo value uses quarter notes per minute, while a displayed beat unit may be different or dotted. Report conflicting values instead of silently treating them as equivalent. [MusicXML playback parameters](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/sound/).

## Score following

The practice engine follows onset groups: all distinct pitches that begin at the same musical position in the selected hand or hands. Matching is based on fresh key presses at the current required position. A correct attack remains counted after key release; holding duration and simultaneous physical holding are not grading requirements.

| Situation | Required behavior |
| --- | --- |
| Single note | Require a fresh key press of the expected sounding pitch and octave. |
| Block chord | Accept fresh attacks of its required pitches in any order. Remember each accepted attack after release. Complete input when every required pitch has been played; accompaniment also respects its transport gate. |
| Marked rolled chord | Use the same remembered-attack rule, including wide chords and rolls spanning both staves. No simultaneous hold, minimum hold duration, or fixed roll deadline is required. |
| Reattack within an incomplete group | Replaying an already accepted target pitch adds no progress and is not a wrong-pitch error. It cannot prefill a later group. |
| Partly correct chord | Mark pitches already played correctly, separately from physical key state. Wait for the missing pitches without counting silence or early release as errors. |
| Wrong extra key | Count and show the wrong attack immediately without erasing correct attacks. Completing all required attacks satisfies the group even if the wrong key remains held; the held state adds no further errors and cannot satisfy a later target. |
| Repeated untied pitch | Require release and a new attack. A held note cannot satisfy the next occurrence. |
| Tied continuation | Do not demand another attack at the tie continuation. |
| Sustain resonance | Track it separately from physical keys; it never satisfies a fresh attack. |
| Shared pitch in two voices | One physical attack can satisfy the same simultaneous pitch. Do not require two presses of one key. |
| Notes held from a previous group | Do not classify a previously accepted held key as a new wrong attack. Release accuracy is not a first-release gate. |
| Rest or position containing only tie continuations | Keep the notation visible, but move the next-notes cursor to the next playable onset. |
| Notes played ahead of the current incomplete group | Treat unmatched new attacks as errors. Do not buffer them to clear later groups automatically. |

Releasing a correct key or the sustain pedal never removes an accepted attack from the current group. Complete the group's input requirement immediately when every required pitch has received a fresh attack; do not wait for note lengths, key releases, or pedal releases. Free advancement applies in both-hands practice; with automatic accompaniment, the transport also waits for the group's musical position as defined below. Track accepted attacks separately from physically held keys and pedal-sustained sound. A key held before the group became current cannot satisfy it without a fresh attack, except that tied continuations require no attack.

In this forgiving reading mode, the player can assemble any chord slowly, with no timeout between its members. “When it is supposed to be played” means the current required score position. Automatic accompaniment adds the transport synchronization rule below, while holding duration remains ungraded. Marked rolls preserve their direction in the score and reference playback, but pitch practice accepts their members in any order. Separately written arpeggio notes with different onsets remain successive required groups; do not merge them into one chord or accept future notes early. Strict simultaneity, roll-order grading, and hold-duration grading are outside the first release.

For MusicXML, preserve arpeggiation membership, direction, and shared cross-staff numbering. A shared roll across both staves is one linked musical gesture. Hand selection filters its required pitches without assigning hands by staff or pitch. Ordinary marked rolls are supported for scored pitch practice and must not be rejected solely because the chord cannot be held in one hand. [MusicXML arpeggiation](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/arpeggiate/).

Synthesia's documented melody practice waits for correct notes before continuing. That is the reference interaction; Pianissimo's rules above explicitly omit hold-duration grading as requested. [Synthesia melody practice](https://synthesiagame.com/).

Correctness means sounding pitch, including octave. An active ottava marking is reflected in the expected sounding pitch, playback, note-name hints with octave numbers, and keyboard rescue. Preserve the written notation and apply the octave displacement exactly once; do not transpose pitches again when the importer has already resolved them. Enharmonic spellings that represent the same piano key match the same MIDI pitch. Hint labels follow the player's accidental and enharmonic-simplification settings; these preferences never alter the expected MIDI pitch or the engraved score.

The cursor never passes a required onset until its notes are correct. It is not forced forward by a metronome. Rests, note lengths, and expressive details remain part of the music and reference timing, but this mode does not enforce them as pitch gates.

Every input event is consumed at most once. Clear the current group's accepted-attack set on advancement, seeking, restarting, changing hands, or interruption; resuming ordinary paused reading retains the same group's progress. Keep physical key state separate so a held key is never mistaken for a new attack. Reconnection requires fresh attacks. Application-generated playback events and any verified returned echoes never count as the pianist's input; they cannot advance a group, start the performance clock, trigger a hint pedal, or create an error.

## Mistake feedback and hints

A wrong physical key press counts as one wrong-note attack. Holding the key, releasing it, or letting it ring under sustain does not add errors. Several wrong keys in a chord count separately.

Make errors unmistakable: a broad red border or translucent red screen wash for approximately 300 ms, plus a clear error symbol and “Wrong key” status at the current position. Keep the notation readable. Repeated errors extend the feedback instead of producing rapid flashing. The local score marker clears on correct completion of the group. The keyboard guide may continue to identify an offending key while it is physically held, but its release is not an advancement gate. Color must be accompanied by text or shape.

Whenever a graded wrong key-down occurs under an active ottava marking, immediately emphasize the marking and its visible bracket or dashed span in red with a bold outline or other shape cue. This applies to every wrong note, whether it is in the wrong octave or is an unrelated pitch. Highlight on the first error, independently of the automatic note-name hint threshold. Support one- and two-octave shifts in both directions, including 8va, 8vb, 15ma, 15mb, and equivalent notation styles.

Determine which ottava spans are active from the current expected score position and the selected practice parts, respecting the imported staff or voice scope and exact start and end positions. In both-hands practice, highlight all applicable active spans on the selected parts, including a staff currently resting or continuing a tie. MIDI cannot identify which hand made the mistake, so do not infer the relevant marking from the wrong key's pitch or present the highlight as proof of an octave error. A held or tied note does not extend a marking beyond its encoded scope. If no applicable ottava is active, use the ordinary error feedback.

If the original ottava label is offscreen, show and emphasize a compact reminder beside the cursor, associated with the relevant staff. Keep the ottava warning visible until the current required group is completed correctly; clear it on seeking, restarting, or interruption. Repeated errors maintain the emphasis without flashing. This warning points out an existing score instruction and does not reveal note names or alter scoring.

Error feedback must not itself reveal the expected note's name before temporary hints are enabled. Independently enabled persistent score labels may already show that name according to the user's label mode and rules.

| Help level | What appears | How it is requested |
| --- | --- | --- |
| Normal notation | Current position and pitch-matching feedback | Default state |
| Persistent score labels | Names beside all notes, or only notes meeting the configured clef-specific pitch conditions, throughout the score | Explicit All notes or Conditional choice in Labels |
| Note names | Labels beside the currently required notes, with accidentals and octave information | Automatically after two wrong attacks at the current group, or immediately through Hint or the assigned pedal |
| Keyboard guide | The exact keys on a piano diagram, with hand labels and octave landmarks | Explicit Show keys action |

The automatic threshold is configurable, including one mistake, two mistakes, another positive threshold, or off. Count errors per current onset group and reset the threshold counter on advancement. Once a timed hint expires, do not instantly reveal it again from the same accumulated errors; require another threshold's worth of errors or a manual request.

The Hint button is the requested give-up control; it reveals information without skipping the notes. The keyboard guide is the final rescue level. It does not open automatically after repeated Hint presses.

Default temporary hint lifetime is 30 seconds of active practice time. Offer shorter and longer durations and an Until correct option. A manual request restarts the timer. Completing the current group immediately retires its temporary hints and starts fading any labels not retained by persistent mode, without delaying matching or score advancement. Pausing ordinary reading freezes the timer and any fade in progress, allowing resumption. Pausing a scored passage attempt interrupts it and dismisses its temporary hints with the same rule. Persistent score labels have no expiry timer and remain visible while their mode and rules apply.

Labels must disappear through a smooth opacity fade, not abrupt removal, when no persistent or temporary reason to display them remains. Use a proposed default fade duration of 300 ms. For temporary timed expiry, fade temporary-only labels during the final 300 ms of the configured active lifetime so they are fully invisible at expiry; clamp the fade to the lifetime if it is shorter. Labels still required by persistent mode remain visible. For correct completion or explicit dismissal, begin the fade when that event occurs, unless the label remains eligible under the persistent score-label mode. Keep outgoing labels attached to their original notes and reserve their layout space; never transfer them to the next group or let them cover newly required notes. Remove the outgoing label content when the transition finishes. A fresh manual hint request for the same current group cancels an in-progress fade, restores full opacity, and restarts the temporary lifetime. Apply the same opacity transition when hiding the keyboard guide. The transition does not erase assistance records or reveal additional targets. Before marking a new scored attempt Ready, finish any outgoing label fades, including fades caused by a restart, repeat reset, or label-setting change. Still-eligible persistent labels remain visible and are recorded as assistance in the new attempt where applicable. Advancement between groups within an ongoing attempt never waits for the fade.

Offer letter names C D E F G A B and fixed-do names do re mi fa sol la si, with a si/ti preference. Fixed do means C is always do. Movable do is a separate future feature because it requires key-dependent interpretation.

Offer two configurable note-name settings: Always show effective accidentals, enabled by default, and Simplify enharmonic names, disabled by default. They apply to persistent score labels, temporary note-name hints beside the score, and note-name labels in the keyboard guide, in both letter-name and fixed-do modes.

With Always show effective accidentals enabled, every hint names the actual pitch independently of the key signature and any earlier accidental in the measure, as if the label were read without a key signature. A C made sharp by the key signature is labeled C♯; a B made flat is labeled B♭, even when no accidental is printed beside that note. A natural pitch is labeled by its natural name, with a natural sign where useful to clarify a cancellation. This changes hint presentation only; it does not transpose the music to C major or remove the score's key signature.

With Always show effective accidentals disabled, hints may omit redundant accidentals already implied by the current key and measure context, following ordinary notation conventions. Explicit changes and cancellations must remain visible. The setting hides redundant accidentals, never necessary ones.

With Simplify enharmonic names enabled, replace awkward spellings with simpler names for the same piano key: B♯ becomes C, C♭ becomes B, E♯ becomes F, and F♭ becomes E. Reduce double accidentals to a natural name where possible, otherwise to a single sharp or flat, retaining the original sharp or flat direction when choosing between equally simple black-key names. Keep ordinary single-accidental spellings such as E♭ and C♯; do not respell all flats as sharps. When disabled, preserve the score's original note-letter spelling.

| Original effective pitch | Explicit hints with simplification off | Explicit hints with simplification on |
| --- | --- | --- |
| C4 sharpened by the key signature | C♯4 | C♯4 |
| B4 flattened by the key signature | B♭4 | B♭4 |
| B♯4 | B♯4 | C5 |
| C♭4 | C♭4 | B3 |
| E♯4 | E♯4 | F4 |
| F♭4 | F♭4 | E4 |
| F𝄪4 | F𝄪4 | G4 |
| B𝄫4 | B𝄫4 | A4 |

When simplification is enabled but redundant accidentals are hidden, show any accidental or natural sign needed to make the rewritten name correct in the prevailing key and measure context. For example, B♯4 in C♯ major becomes C♮5 in that contextual mode, rather than an ambiguous C5. The two preferences remain independently selectable.

Derive labels from the already-resolved pitch and retained source spelling; do not apply a key signature a second time or rely only on whether an accidental glyph is visible. Recalculate the displayed octave after respelling: B♯4 is C5 and C♭4 is B3. Use middle C = C4 or do4, with octave labels independently configurable. Apply the same naming policy before converting to fixed do, so C♯ becomes do♯ and a simplified B♯ becomes do in the correct octave. [MusicXML pitch spelling and octave representation](https://www.w3.org/2021/06/musicxml40/tutorial/midi-compatible-part/).

These naming settings leave the printed notation, key signature, playback, MIDI matching, scoring, highlighted physical keys, and conditional label eligibility unchanged. Persist both preferences with the other app settings. Changing them updates any visible note labels without revealing hidden hints or restarting their visibility timer.

For chords, place labels without covering noteheads, ledger lines, or accidentals. If the available space is insufficient, use a nearby stacked callout linked to the correct notes.

## Persistent score labels

Provide a score-reading aid that labels notes throughout the whole score without requiring a mistake, a Hint request, or arrival at the current onset. It is available during ordinary reading, scored practice, paused inspection, and Listen. The Labels control offers three modes:

| Mode | Behavior |
| --- | --- |
| Off | No persistent labels; automatic and manually requested temporary hints remain available. |
| All notes | Label every supported pitched note on both displayed staves, including notes ahead of and behind the cursor, each chord member, tied continuations, and repeated occurrences. Do not label rests. |
| Conditional | Label only notes satisfying the pitch conditions configured for their active clef. Conditions apply across the whole score, not just at the current onset. |

For Conditional mode, provide separate settings for G clef (treble) and F clef (bass). Each has independently enabled Show below and Show above conditions with editable pitch thresholds. A threshold includes a note name, accidental where needed, and octave, even when octave display in labels is disabled. Combine enabled conditions with OR. Either condition can be used alone; disabling both produces no persistent labels for that clef. Do not copy treble thresholds into the bass settings implicitly. If another supported clef appears, give it its own rule entry, initially with both conditions disabled.

Use strict comparisons: Show below C4 means pitch < C4, and Show above C5 means pitch > C5. With both rules enabled for G clef, B3 and C♯5 receive labels; C4, E4, and C5 do not. The entire range from C4 through C5, including both boundaries, remains unlabeled by this mode. Bass-clef boundaries are independently configurable in the same way. Reject invalid pitches and, when both conditions are enabled, a lower boundary above the upper boundary. Show a plain-language summary and a live sample of which notes will be labeled before applying the settings.

Compare resolved sounding pitches, including accidentals and ottava displacement, consistently with the piano keys named by the existing hints. Do not compare note-name strings, raw staff height, or the presence of a printed accidental. Enharmonic equivalents have identical eligibility, and changing label spelling or naming language never changes which notes qualify. The rule belongs to the clef governing the note's displayed staff at that musical position, including clef changes and cross-staff notation; it is independent of left/right-hand assignment. Evaluate chord members separately. Labels on the unselected hand remain subdued with that staff but follow the same mode and their own clef's rules.

Place each label beside its own notehead with a small readable gap and an unambiguous association. Prefer an adjacent free position, staggering nearby labels above or below as necessary. For dense chords or multiple voices, use compact adjacent stacks with short connecting lines where needed; never replace note-adjacent labels with a detached legend or a hover-only display. Protect the next notehead, accidentals, ledger lines, stems, beams, ties, slurs, and other score markings from overlap. If existing space is insufficient, increase horizontal event spacing across both staves together, and add vertical label space where needed. Do not silently omit qualifying labels or shrink them below readable size. A shared graphical notehead needs only one label.

Prepare label positions and enough space for temporary hints before advancing through the affected measures. Recalculate placement on zoom, orientation, or label-setting changes while keeping the current musical position anchored. A layout change during scored practice interrupts that attempt rather than changing spacing while its completion time is being measured. Settings can be previewed and applied while paused. Keep long-score rendering bounded to the visible region and neighboring measures; every note remains eligible for labeling as its region is brought into view.

Use the same letter-name or fixed-do, accidental, enharmonic-simplification, and octave preferences as temporary hints. Persistent labels do not expire or disappear on correct notes, pauses, or loop resets. Fade them out when the mode is disabled or their rule no longer matches, using the existing opacity policy. A temporary hint can reveal current notes excluded by the conditional rules; show one label per note when both sources of visibility apply. Expiry or completion removes only the temporary source, leaving any persistent label visible. Turning persistent labels off must likewise preserve a label whose temporary hint is still active.

Persist the mode and each clef's conditions with settings and include them in export/restore. The default mode is Off. Offer the user's treble example, below C4 or above C5, as an editable preset; leave bass thresholds unset until selected. Applying a changed mode or rule during a scored attempt interrupts that attempt before the new layout or labels appear, and the next attempt records the new settings. This does not change the existing behavior of the Hint button or naming-only preferences.

Visible persistent labels count as note-name assistance, including labels exposed during preparation, while waiting for the first key press, or during read-ahead. Record the revealed note and performed occurrence, and attribute the exposure to that note's measure and group rather than to the cursor's current measure. Within the same attempt or ordinary-reading traversal, a future group whose names were already exposed remains assisted when reached, even if the labels have since been hidden. Start a fresh exposure record for each new attempt or traversal and immediately record labels still visible; prior assistance remains in history but does not permanently mark a note as assisted. Enabling Conditional mode without revealing any labels does not itself count as assistance. Hiding labels later never removes recorded assistance. Keep persistent-label exposures distinct from automatic and manually requested temporary hints in result details; they do not increment the hint-request count.

## Keyboard rescue

Show a Synthesia-like keyboard with highlighted target keys and vertical bars aligned above them. In reading mode the bars wait at the playing line until the required keys are pressed. The guide follows score progress rather than moving past an unresolved note on a wall clock. Its note-name labels use the same accidental and enharmonic-simplification preferences as the score hints.

Provide an enlarged view of the relevant pitch range and a small full-keyboard locator so distant octaves remain unambiguous. Distinguish left and right parts using both labels and color. Distinguish targets already played correctly from keys currently physically held. Keep an accepted target visibly completed after release until the group advances. Mark an incorrect played key visibly and preserve any marked roll direction.

The panel must accommodate wide chords and low or high notes without hiding a required key. It must not introduce finger numbers unless the score supplies fingering or the user explicitly adds it.

Showing this guide marks the attempt as keyboard-assisted even if the player subsequently hides it.

## MIDI input, output, and pedal controls

The connection view lists MIDI inputs and outputs separately. Select one piano input and a verified output destination, with the piano's supported receive channel or part. Provide live key and pedal input tests and an explicit Play test note action to confirm audible output. Remember the route and its tested channel/pedal behavior. For traditional MIDI sockets, the piano's MIDI Out feeds the interface's MIDI In, and the interface's MIDI Out must also connect to the piano's MIDI In for automatic playback.

Physical-piano playback is required for the default one-hand and Preview modes. Send the app's assigned notes, releases, velocity, and supported controller events through MIDIOutput. A visible output port is not proof that the connected instrument can sound it. If no working receiving route exists, explain the missing capability and disable physical-piano playback. Browser sound may be offered as an explicitly chosen alternative; it must not silently substitute for the required instrument output. [Web MIDI output](https://www.w3.org/TR/webmidi/#midioutput-interface).

Keep keyboard input and automatic output separate. Prefer an echo-free route or verified distinct ports/channels. Standard MIDI input carries no trustworthy application-origin tag: do not discard a real key press merely because its pitch and timing resemble a recently sent note. If returned playback cannot be distinguished from human input, disable graded accompaniment for that routing until it is corrected. Preview can run without grading, but must not forward received echoes back to the output.

Keep the piano's local keyboard sound enabled by default and send only the automatically assigned part. Do not automatically retransmit the learner's notes, change Local Control, change the instrument's patch, or reset every channel. Prefer an independent receive channel/part for accompaniment, and verify that its releases do not cut off a human-held note of the same pitch. If a pitch starts simultaneously in both the learner and automatic part, require the learner's attack and suppress the redundant automatic attack; in Preview, merge simultaneous unisons. Track app-owned notes and overlapping voices separately so an older release does not prematurely stop a newer note.

Preview sends the supported score pedal events. In one-hand practice, the pianist controls shared pedals by default; send automatic pedal changes only when their effect is verified to be confined to the automatic part. Do not let two independent pedal sources fight over the same receiving part. The assigned hint pedal retains its input function. An accompaniment-level control changes only app-generated playback, using velocity scaling unless isolated channel-volume behavior is verified.

Required input handling includes Note On, Note Off, velocity, timestamps, channels, and pedal controller messages. Treat Note On with zero velocity as a release. Preserve continuous pedal values where the device provides them. Separate physically depressed keys from sustained sounding notes.

Sustain is normally controller 64, sostenuto 66, and soft pedal 67. The conventional on/off boundary is 64, but the app must learn what the actual piano transmits. [MIDI Association controller definitions](https://midi.org/midi-1-0-control-change-messages).

Provide a “Set hint pedal” action: the user presses the desired pedal, the app observes its message, and a test confirms the mapping. Prefer the middle pedal when it sends a usable message. Trigger once per press, requiring release before another trigger. Provide configurable inversion and threshold when necessary.

By default, the assigned pedal reveals note names only. Optionally let the user assign it to Show keys instead. Do not overload repeated taps with hidden escalation behavior.

If the instrument does not transmit the middle pedal, explain that in setup and retain the on-screen Hint button. Repurposing the pedal in the app may not stop it from changing the piano's own sound.

Record pedal and velocity information for playback diagnostics and future assessment. The first release judges pitch attacks, not nuanced pedal technique, dynamics, articulation, or physical fingering. A received controller message is not evidence that the app can assess its musical quality.

On Pause, Stop, seeking, mode changes, or app suspension, stop the automatic scheduler, clear unsent MIDI output, send explicit releases for tracked app-owned notes, and release app-owned pedal states on the tested playback channels. Clearing a queue alone does not silence notes already sent. Provide Stop sound for stuck-note recovery; confine cleanup to the app's output route. Interrupt any active scored attempt where required by the practice rules. On disconnect, stop scheduling and mark the attempt interrupted; cleanup cannot be delivered while the link is absent. Reconnect, reset the tested output state, and require clean physical key and pedal state before restarting.

## Repeating passages

Select a contiguous range of measures with visible start and end handles. Selection includes both boundary measures. Offer tap-based start and end selection as well as dragging. Save named passages and switch among them; joining disconnected bars into a synthetic passage is outside the first release.

Show the selected hand, measure range, repeat occurrence, and practice tempo before starting. If the selected hand has no required onsets in the passage, disable scored practice and explain why; retain Listen and selection controls. Repeat the passage indefinitely or until a chosen number of consecutive passes.

The default pass condition is completion with zero wrong-note attacks and no assistance, including persistent note labels, temporary hints, or keyboard rescue. Timing appears separately. An optional timing tolerance can be added to the pass condition, but it must be labeled as total completion-time tolerance, not proof of rhythm accuracy.

After each attempt, show a compact result while preserving the score. Finish any remaining automatic part to the passage boundary and release app-owned output, then wait for physical keys and every sound-retaining pedal, including sustain and sostenuto where supported, to be released, then finish reset and return directly to Ready at the passage's beginning. The next attempt's clock starts only on its first fresh human key press; restarting the automatic part does not start it. Reset matching state, local error counts, and temporary hint visibility; retain the passage, settings, and qualifying persistent score labels. Record visible persistent labels in the next attempt's assistance data.

At a loop start inside an existing tie or held note, require a new attack for any note that should already be active and mark it as a practice-boundary reattack. At the loop end, stop the practice segment without waiting for sound or reverb to decay. Keep source notation unchanged.

Changing hands, tempo, range, or score position during a scored attempt interrupts that attempt and creates a new comparison context. After a tempo change, the next scored attempt starts at the selected passage's beginning using the new tempo and recalculated target duration. During ordinary unscored reading, tempo changes reschedule automatic playback and the metronome without skipping the current learner target. A disconnect, pause during a scored attempt, or background suspension never records a failed or successful completed performance.

## Suggested practice

Add a Suggested practice section to the piece's Library view and Passage Results. It identifies recurring trouble in previously played bars and offers a focused loop. Show up to three suggestions, updated between attempts; never interrupt playing or change the selected passage automatically.

Each suggestion shows the affected bars, selected hand and practice tempo, a small notation preview, and the evidence behind it. Use specific language instead of an absolute claim such as “You always make mistakes here.” Example: “Mistakes in bar 13 on 3 of your last 5 comparable passes. Practice bars 12–14?” This is example interface copy, not recorded user data.

### Detecting recurring mistakes

For each measure, retain a rolling history of its five most recent complete traversals. Compare the same score version, repeat occurrence, hand selection, tempo map and speed, reference-roll realization policy, accompaniment/transport mode, and matching rules. A complete traversal covers all required onset groups in that measure, even if the player later interrupts the larger passage. Unvisited bars provide no evidence, and partially played bars never count as clean.

Proposed default: flag a measure when there are at least three complete traversals, at least three contain a wrong-note attack, and at least 60% of the available traversals contain mistakes. Thus three error-bearing passes out of five qualify; one pass containing many wrong notes does not. Count each traversal once for this trigger regardless of how many wrong keys it contains.

Assign mistakes to the current expected onset and its measure. Record wrong attacks, affected onset groups, temporary hint use, and persistent-label exposure separately. Attribute a label seen in advance to the revealed note's measure, retaining that assistance when the measure is traversed. Synthetic reattacks introduced only by a loop boundary must not inflate the original passage's mistake history.

Also detect a repeatedly abandoned difficult bar: three user-initiated restarts or stops after wrong notes in that bar can generate a separately labeled suggestion, such as “You restarted at bar 13 after mistakes three times.” Keep incomplete visits separate from complete-pass percentages. Exclude device disconnections, app suspension, setup input, and manual seeks from this trigger.

### Choosing and starting the passage

Merge adjacent flagged bars before ranking suggestions. Rank by the recent proportion of passes containing mistakes, then evidence count and recency; do not rank by lifetime mistake totals. Repeated-restart suggestions show their own evidence and follow suggestions supported by complete traversals.

Add one context bar before and after the problem area where available. Distinguish these context bars from the bars identified as difficult. For a long cluster, propose manageable passages of at most eight bars and allow the player to adjust the boundaries.

A Practice this passage button opens the existing repeat workflow with the suggested range, hand selection, and tempo already selected. The player can review the range, listen, change settings, or start. Changing tempo or hand creates a separate comparison context and does not erase the original suggestion.

### Recognizing improvement

Once flagged, a suggestion remains active until every flagged bar has three consecutive complete, clean, unassisted traversals in the same comparison context. Clean means zero wrong attacks and no persistent note labels, temporary note-name hints, or keyboard hints revealed for that traversal, including earlier read-ahead exposure. An error-bearing or assisted traversal resets that bar's clean streak. Partial traversals never advance it; observed mistakes in a partial traversal break it. Merely falling below the rolling detection threshold does not remove the suggestion.

Show progress, such as “2 of 3 clean passes,” and move resolved suggestions to an Improved section. New recurring errors can flag the passage again. Context bars do not need to be mastered to resolve a suggestion.

Allow the player to dismiss a suggestion for the current session, disable suggestions, or clear the piece's practice history. Persist measure histories, active suggestions, and recovery streaks locally with the existing export and restore data. No cloud analysis is required.

## Results and timing

Use a transparent scorecard rather than a single unexplained points total.

| Result | Definition |
| --- | --- |
| Completion | Completed, interrupted, or abandoned |
| Wrong-note attacks | Number of incorrect physical key presses during the attempt |
| First-pass groups | Percentage of required onset groups completed without a wrong attack |
| Completion time | Time spent reaching and completing the final required onset, measured as defined below |
| Expected time | Reference attack span, including the defined spread of a final marked roll and excluding final sustain |
| Time difference | Actual minus expected, in seconds and as a percentage when the expected time is nonzero |
| Assistance | None, note names, or keyboard guide; distinguish persistent score labels from temporary hints and record label settings, exposures, requests, and groups revealed |
| Practice streak | Consecutive attempts meeting the selected pass condition |

Create the attempt record when Start prepares the passage or a repeat reset begins. Once the score is ready and reset is complete, enter Ready immediately and accept fresh key presses; the performance clock remains stopped until the first human press arrives, even if the automatic part is already playing. Hints and labels visible before that press still mark the attempt as assisted, including read-ahead exposure attributed to the revealed groups. Input during setup or reset updates physical key state but cannot satisfy the new attempt. Entering Ready requires the previous keys and sound-retaining pedals to have been released; using a hint pedal after Ready does not cancel readiness or start the clock.

Use attack-span timing for the first release. Start the clock at the timestamp of the first fresh human key press from the selected MIDI input while the attempt is Ready, even if that press is wrong, and process that same event for matching and mistakes. A fresh key press is a Note On with positive velocity; Note Off, zero-velocity Note On, pedal messages, Hint, Start, and application-generated playback do not start the clock. If enabled, the practice metronome begins with that first press in both-hands mode; during automatic accompaniment it follows the separate musical transport. Stop when the final required onset group receives its last missing correct attack, regardless of which keys or pedals remain held. Hesitation, chord assembly, and wrong-note recovery after the first press count. Waiting before the first press, automatic playback before that press or after the final required attack, final note sustain, and loop-reset time do not.

Compare this with the reference attack span for the selected part: from its first required attack to the latest required attack in its final group. Ordinary chords retain their shared onset time. For a marked rolled chord, use the reference playback realization below so an intended final roll contributes its reference spread instead of being treated as unexplained delay. The player's actual roll and hesitation time still count toward completion time. Reference roll timing is an app interpretation when the source provides no explicit performance timings, not a precise duration encoded by the arpeggio symbol. Label it “Completion time” with this definition available in the result details. Show the full notated passage duration separately; exclude final sustain and trailing rests from the attack-span target. A passage containing only one written onset group still has no tempo ratio, even when that chord is rolled.

For example, four quarter-note attacks at quarter note = 60 have an expected attack span of 3 seconds and a full notated duration of 4 seconds. A passage with only one onset group has no meaningful tempo ratio; show errors and assistance, with an optional ungraded time-to-solve.

Calculate target time from the numerical tempo map and the metronome beat unit. For each constant-tempo segment: seconds = 60 × segment length in whole notes ÷ (BPM × beat-unit length in whole notes). Sum the segments. A dotted-quarter beat occupies three eighth notes, not one quarter note.

Provide one tempo control for reference playback and practice, available for both hands, either hand, the whole piece, and selected loops. The player can choose presets of 0.5×, 0.75×, 1×, 1.25×, 1.5×, and 2×, use a slider, or enter a custom speed multiplier or BPM. Custom input is not limited to the preset values or slider stops. Reject zero, negative, non-finite, and invalid values with a clear message. Offer Reset to original tempo.

Display both the multiplier and the effective BPM, including the metronome beat unit. BPM entry sets the tempo at the selected passage's start and derives a multiplier from the source tempo there. Apply that multiplier to the entire tempo map, preserving relative tempo changes. For example, quarter note = 120 becomes 60 at 0.5× and 240 at 2×; a later source tempo of 90 becomes 45 or 180 respectively. Changing speed never changes pitch, octave, note spelling, or notation.

Apply the same multiplier to reference playback, its cursor, note and pedal event timing, the metronome, and expected passage duration. Expected duration equals the original duration divided by the multiplier: 0.5× doubles it and 2× halves it. Waiting practice still advances only when the required pitches are correct. Hint visibility remains measured in actual active seconds, so the default 30-second timer is unaffected by tempo. Record the selected multiplier with every scored attempt and remember the last selected speed for each piece.

Missing numerical tempos require user input to establish the reference tempo before relative speed controls can be used. Unresolved fermatas, rubato, and annotation-only tempo changes remain timing-unscored until a policy is explicitly supplied; changing speed does not resolve them.

A faster result is not automatically better. Rushing can cancel a hesitation in the total. Preserve onset timestamps for later rhythm analysis, but do not label total elapsed time as rhythm accuracy.

Assisted and unassisted attempts must remain distinguishable. Compare results only for the same score version, selected passage occurrences, hands, tempo map and speed, reference-roll realization policy, accompaniment/transport mode, and matching rules. Show best clean unassisted performance separately from assisted practice. Incomplete attempts retain diagnostics but do not enter completion rankings.

Because the app waits for every required pitch, a completed attempt cannot contain an omitted required note. Do not invent a “missed notes” metric for this mode.

## Listening and hand practice

Preview (neither hand), also available through Listen, sends both parts of the whole piece or selected passage to the connected piano. Start playback immediately after the user's Play action using the score's tempo map, repeat order, dynamics, supported pedals, and a moving cursor. No learner input is required and no mistakes, practice score, or performance stopwatch are recorded. Retain optional listening filters for hearing just the left or right part.

Provide Play, Pause, Stop, return to passage start, playback level, and speed controls. Sound starts after an explicit user action. Stopping, seeking, or switching modes cancels queued output and releases app-owned notes and controllers in the selected output backend. During Preview, tempo changes take effect from the current musical position without restarting the piece. Reschedule future attacks, releases, and pedal changes together so sound and cursor stay synchronized without skipped, duplicated, or stuck notes.

Choose which hands the learner plays. The app automatically plays the complementary part on the connected piano in the first release.

| Learner selection | Learner plays | Connected piano plays automatically | Grading |
| --- | --- | --- | --- |
| Both hands | Both parts | Neither part | Both parts |
| Right hand | Right part | Left part | Right part only |
| Left hand | Left part | Right part | Left part only |
| Neither / Preview | Neither part | Both parts | None |

Only learner-assigned parts create required onset groups. Keep automatic parts visible but visually distinct, with their own playback highlights. Assign hands by the confirmed musical voices, including cross-staff passages. Human presses outside the current learner targets can be errors even when they double an automatic part. Automatic accompaniment is part of the selected practice mode, not note-name or keyboard-guide assistance.

Use separate musical-transport and learner-performance clocks. In one-hand practice, the transport follows the selected tempo through automatic-only notes and rests. At each learner onset, emit automatic events due at that position once, then hold further musical progression if the learner's required attacks are incomplete. No automatic attack at a later written position may run ahead while the app is waiting. Automatic members of a roll belonging to the current written onset may finish their defined reference spread; those offsets do not create extra learner gates. Already sounded notes may finish their scheduled releases and decay. Resume from the held position without replaying the same accompaniment or emitting a burst of overdue notes.

A correct fresh attack for the current learner group may be accepted early while its musical position approaches, and remains accepted after release. During accompaniment, the transport and cursor pass that group only after both its musical position is reached and its required attacks are complete. This is the specific exception to immediate free advancement: it preserves the automatic part's rhythm. Do not accept or buffer attacks for later groups. Both-hands practice retains its existing immediate pitch-based advancement.

Start or a repeat restart may play a genuine automatic-part introduction before the first learner onset. The attempt is Ready once preparation is complete, independently of whether automatic playback has begun. Its performance clock still starts only on the first fresh human key press, including a wrong press; an early press during the introduction is processed against the current learner group rather than silently discarded. The transport or an automatic note never starts that clock. If enabled, the metronome follows the musical transport during accompaniment.

The learner's measured completion time ends on the final missing correct attack. If that attack was early, wait for its musical position before completing transport progression. Let the remaining automatic part reach the passage boundary before resetting a loop; this final automatic passage and output cleanup are outside the learner's measured time. Preview loops use only the musical transport and create no practice attempts.

The connected piano is the default sound source for the learner's local playing, automatic accompaniment, and Preview. Select a single automatic output destination to avoid doubled playback. Browser synthesis remains an explicit alternative for previewing without a receiving instrument or for an intentionally selected browser-audio configuration; optional monitoring for a silent controller is separate. Its availability does not establish compatibility with the required physical-piano output.

Playback is a reference performance generated from the common score model and sent to the selected sound destination. For MusicXML imports, use supported numerical tempo, dynamics, and pedal instructions when present; notation-only or missing expressive instructions require a defined interpretation. [MusicXML playback parameters](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/sound/).

For notation-only rolled chords, create a deterministic reference performance. Use the marked direction, defaulting to low-to-high when no arrow is supplied. A shared cross-staff arpeggiation uses one sweep; independently marked rolls start together. Proposed default total spread from first to last attack is 120 ms at 1×, shortened when necessary to at most half the interval from the written onset to either the next written attack or the earliest affected note ending, whichever comes first. Space the roll's distinct fresh pitches evenly within that span and preserve their notated ending times. A single fresh pitch has zero spread. If source-resolved performance timings already specify the roll, preserve them and do not add another spread. Derive this full-piece realization before filtering to either hand, then scale all its timings with the selected tempo multiplier. Keep written score positions unchanged and store reference attack offsets separately. The spread supplies playback and the expected completion-time endpoint; it never becomes a deadline or hold requirement for the player's chord.

## Recommended defaults

| Setting | Default |
| --- | --- |
| Practice behavior | Wait for correct pitches |
| Active hands | Both; right-only and left-only include automatic accompaniment, and neither selects Preview |
| Automatic sound destination | Verified MIDI output to the connected piano |
| Accompaniment synchronization | Selected tempo between learner onsets; wait at incomplete learner groups |
| Persistent score labels | Off; All notes and Conditional available |
| Conditional score labels | Independent strict below/above rules per clef; editable treble preset below C4 or above C5; bass thresholds unset until chosen |
| Label threshold pitch | Resolved sounding pitch, including accidentals and ottava |
| Automatic name hints | After two wrong attacks at the current group |
| Hint lifetime | 30 seconds of active practice time |
| Hint dismissal | Smooth opacity fade; proposed duration 300 ms |
| Naming system | Letter names, with fixed do available |
| Always show effective accidentals | On; key-signature and carried accidentals are explicit in hints |
| Simplify enharmonic names | Off; optional simpler names for the same piano keys |
| Keyboard guide | Explicit request only |
| Hint pedal | Learned middle-pedal message when available |
| Chord matching | Remember correct attacks after release; no simultaneous-hold or hold-duration requirement |
| Marked-roll reference spread | Proposed 120 ms total at 1×, shortened to fit the available musical interval and scaled with playback tempo |
| Playback and practice speed | 1× the source tempo map; presets and custom multiplier or BPM available |
| Attempt clock | Starts on the first fresh key press in Ready, including a wrong press; repeats return directly to Ready after reset |
| Metronome | Off; optional audible reference without forcing advancement |
| Repeat target | Unlimited attempts; optional consecutive-pass target |
| Clean pass | Zero wrong attacks and no persistent-label, temporary-hint, or keyboard assistance |
| Input monitoring through browser sound | Off |
| Reference playback | Both hands |

## Technical design

### Chosen stack and version policy

Use TypeScript throughout application code, with the latest stable release rather than a beta or nightly. Verified on 28 October 2026, that is TypeScript 7.0.2; TypeScript 7.1 is still in beta. Recheck the stable release when implementation begins, pin exact dependency versions and a lockfile, and upgrade through the compatibility checks below. TypeScript and the build tool run on the development machine or in CI; the iPad receives compiled JavaScript, not a TypeScript compiler. [TypeScript releases](https://github.com/microsoft/TypeScript/releases), [TypeScript documentation](https://www.typescriptlang.org/).

| Layer | Decision |
| --- | --- |
| Build | Vite 8.3.5 with the Preact preset; produce static assets for GitHub Pages. |
| UI | Preact 11.1.0 and @preact/signals 2.11.4 for controls, settings, and small reactive status updates. Keep the score's graphics outside whole-app component reconciliation. |
| Styling | Native CSS with CSS Modules, system fonts for interface text, and only the notation fonts required by the selected renderer. Use small purpose-built controls without a large component suite. |
| Practice engine | Framework-independent TypeScript state machine for MIDI decoding, accepted attacks, onset progression, mistakes, hints, and timing. |
| MusicXML import | fast-xml-parser 5.11.2 with document order preserved, plus fflate 0.8.3 for .mxl. Run validation and normalization in a dedicated worker and release temporary parse trees afterward. |
| MusicXML engraving | OpenSheetMusicDisplay (OSMD) 2.2.1 is the preferred prototype candidate, behind a renderer adapter. Retain its supported VexFlow dependency rather than overriding it with a separate newer VexFlow. Final adoption depends on the engraving and performance gates below. |
| MIDI | Direct Web MIDI API through a small typed adapter, with both input and instrument output, using MIDIWeb on iPad and standard desktop Chrome as already specified. |
| Playback | MIDIOutput to the connected piano by default; native Web Audio with a compact piano bank for the explicitly selected browser-audio alternative. |
| Persistence | IndexedDB through idb 8.0.4 for source files, score packages, settings, and history; export and restore remain required. |
| Verification | Vitest for musical-model and matching tests; Playwright Chromium and WebKit for browser workflows; physical-device tests for MIDIWeb, MIDI hardware, memory pressure, and latency. |

The listed package versions are the verified stable starting point, not permission to ship floating versions. Preact is selected for its small UI runtime and focused updates; performance still depends on application architecture. Use Signals for small view state, not a deeply reactive copy of every score note. [Preact](https://preactjs.com/), [Signals](https://preactjs.com/guide/v11/signals/). Preserve MusicXML child order when parsing because backup, forward, and chord elements determine timing. Validate XML well-formedness and supported musical semantics explicitly; a parser alone does not establish MusicXML correctness. [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser), [fflate](https://github.com/101arrowz/fflate), [idb](https://github.com/jakearchibald/idb).

Use strict TypeScript checking, including unchecked-index and exact-optional-property checks, and separate browser and worker type configurations. Keep production syntax compatible with the pinned Vite baseline, explicitly covering Safari 16.4 and Chrome 111 or later; do not ship an esnext target merely because TypeScript is current. Syntax compilation does not supply missing browser APIs. Feature-detect MIDI, audio, workers, storage, and optional wake prevention. Test the production build served under the GitHub Pages project path. [Vite production builds](https://vite.dev/guide/build).

### Execution and rendering architecture

Process every incoming MIDI event immediately and in order on the main thread. Matching operates on compact prepared event data and a small accepted-attack set; it must not parse XML, engrave notation, decode audio, write storage synchronously, or rerender the whole interface. Batch only visual changes with requestAnimationFrame. Preserve accepted attacks independently of physical-key and sustain state. Persist history in asynchronous batches outside the input handler.

Separate initial score preparation from live practice. Expand compressed MusicXML, validate and normalize the score, and calculate musical timing in dedicated workers. Transfer large buffers rather than repeatedly cloning complete scores. Allow one heavy import at a time, with cancellation and progress. If the optional replacement renderer uses WebAssembly, use its ordinary single-threaded build; SharedArrayBuffer, Wasm threads, and a cross-origin-isolation workaround are not requirements.

OSMD's horizontal incremental mode still performs whole-score layout and appends drawing batches; it is not bounded viewport rendering by itself. Its browser renderer depends on the DOM and cannot simply be moved into a worker. The adapter must turn prepared geometry into removable score segments, preserving note identity, shared staff spacing, ottava spans, ties, slurs, and cross-staff gestures. Retain only the viewport plus approximately one viewport of notation on each side, with a bounded geometry cache; clipping or hiding a complete giant SVG is insufficient. Do not retain both a complete hidden SVG tree and the visible segmented copy. [OSMD 2.2.1 implementation](https://raw.githubusercontent.com/opensheetmusicdisplay/opensheetmusicdisplay/2.2.1/src/OpenSheetMusicDisplay/OpenSheetMusicDisplay.ts).

During playing, update current-note styles, accepted-note markers, cursor position, visible labels, and the scroll transform. Do not recalculate engraving in response to each note, pedal event, or animation frame. Reuse prepared label geometry. Prepare and cache additional segments ahead of the cursor in bounded work slices; if needed content is unavailable, pause with a preparing status before entering it instead of losing input or recording a false mistake. Zoom, orientation, and label-layout changes are explicit layout operations and must preserve score position.

Validate OSMD first with the supplied 59-measure reference piece and a 500-measure fixture, including all-note labels. If its adapter cannot meet correctness or performance gates, evaluate Verovio's modular WebAssembly build without optional Humdrum support as a replacement. Ship one MusicXML engraving engine, not both by default. A renderer's MIDI or timing output is not the scoring authority; the common musical model remains authoritative. Do not build a complete custom MusicXML engraver directly on VexFlow for the first release. [Verovio WebAssembly integration](https://book.verovio.org/installing-or-building-from-sources/javascript-and-webassembly.html).

Split notation, MusicXML import, and piano samples into independently loaded assets. Opening the library must not fetch the notation engine or piano bank. Cache completed score packages and reusable geometry so reopening a piece avoids repeated parsing and engraving. Release import-worker resources and temporary buffers after each job. Do not run heavy import processing during an active scored attempt.

Use one musical scheduler with separate MIDI-output and browser-audio backends. Physical-piano playback schedules MIDIOutput messages against the page's monotonic high-resolution clock, with a short lookahead that never queues attacks at written positions beyond an unresolved learner onset; current-onset roll members retain their reference offsets. Support queue cancellation, app-owned note/controller tracking, and rescheduling on tempo changes. Verify timestamp and clear behavior in the chosen browser. For the explicit browser-audio alternative, use one AudioContext and schedule against AudioContext.currentTime. Animation frames display progress but do not drive sound timing. Load and decode piano samples only when browser audio or optional monitoring is selected; physical MIDI playback must not load that bank. [Web MIDI output](https://www.w3.org/TR/webmidi/#midioutput-interface), [Web Audio scheduling](https://web.dev/articles/audio-scheduling).

### Performance targets on the reference tablet

These are initial engineering budgets, not measured claims. Verify the production build in MIDIWeb on the actual reference tablet. A fast development computer or an emulated iPad viewport is insufficient.

| Area | Initial target and measurement |
| --- | --- |
| Initial application code | At most 150 kB gzip-equivalent JavaScript and 30 kB gzip-equivalent CSS for the library/settings shell. Report every deferred chunk and total bytes needed to start MusicXML practice separately; lazy loading must not conceal a large practice payload. |
| MIDI feedback | At least 95% of received MIDI events produce visible feedback within 50 ms. Process every event; measure transport latency separately. |
| Live responsiveness | Target smooth 60-frame/s scrolling without requiring 120-frame/s rendering. Keep app work per visual frame within 8 ms at the 95th percentile and avoid app-generated main-thread tasks longer than 50 ms during practice. |
| Score size | The supplied reference piece and a 500-measure score work with all-note labels enabled. Mounted notation and geometry caches remain bounded while traversing the entire score repeatedly. |
| Sustained use | A 30-minute session has no lost or duplicated MIDI events, audible scheduling glitches, tab reloads, or steadily accumulating live graphics and audio resources. |
| Import lifecycle | Measure cold and cached import time, first usable score, peak memory where tooling permits, cancellation, and return to a stable memory footprint. At most one import job runs at a time; a canceled job produces no later UI mutations. |
| Audio assets | Start with a compact bank targeting at most 8 MB transferred and 32 MiB of decoded PCM. Report both values; compressed file size does not describe playback memory. |
| Static deployment | Workers, fonts, sound files, and any assets required by the chosen renderer load from the deployed project subdirectory with no server API. |

Profile before adding more dependencies or micro-optimizing code. Include build-size reports, fixture-based correctness tests, and performance regressions in the release checks. Playwright WebKit is useful for automated coverage but does not replace MIDIWeb and physical iPad testing. [Playwright browser scope](https://playwright.dev/docs/browsers).

### Common score model and import pipeline

Use one application score model so matching, hints, looping, playback, and suggested practice agree on the imported MusicXML. Parse the score directly, preserving written spelling separately from sounding pitch and resolving voices, chords, durations, ties, repeats, and tempo into performance order. [MusicXML pitch and timing data](https://www.w3.org/2021/06/musicxml40/tutorial/midi-compatible-part/).

Use the renderer-adapter decision and validation gates above; adoption requires engraving quality, bounded rendering, and reliable mapping from visible noteheads to the application score model. Produce a reusable local score package. Serve JavaScript, fonts, sound assets, and any assets required by the chosen renderer as static files with paths that work under a GitHub Pages project subdirectory. Import processing must keep the interface responsive and support cancellation. Live matching, hints, scrolling, timing, and results run locally on either device and must not wait for a network round trip.

The score package contains MusicXML version, source packaging, importer version, and renderer version; rational onsets and durations; written and sounding pitches; staff, voice, and hand assignments; ties and onset groups; arpeggiation membership, direction, cross-staff group identity, and separate reference attack offsets with their realization-policy version; measure and repeat-occurrence IDs; tempo, key, meter, and clef maps; ottava displacement, scope boundaries, staff or voice assignment, and links to the rendered marking and span; supported pedal and dynamic markings; and links to visible noteheads.

Keep source-note identity, performed occurrence identity, and graphic-object identity separate. One source event can occur several times through repeats; one musical note can correspond to several graphical objects. Generate stable application identifiers when the input lacks suitable IDs, and retain the mapping between imported events, rendered notes, and practice history within each score version.

Render the strip as vector notation with bounded visible content and neighboring measures loaded in advance. Avoid an enormous live document or canvas for an entire long piece. Segment boundaries must preserve ties, beams, slurs, and notation context.

Compute conditional-label eligibility from resolved pitches and the clef at each graphical note occurrence. Retain separate persistent and temporary visibility state for each label. The browser renderer must support collision-aware note-label layout and shared horizontal spacing across staves entirely in the browser. Cache prepared label geometry for visible and neighboring measures; scrolling into a new region must not reveal unplaced labels over notation or cause an accumulating whole-score document. Record label exposure by performed occurrence for assistance tracking.

Validate MusicXML and compressed input with file-size, expansion, and processing limits. Disable external entity resolution and external file or network references. Sanitize generated SVG before display, and verify note-to-graphic mappings for the selected renderer.

## Storage and recovery

The first version is single-user and does not require an account. Store imported score packages, settings, saved passages, attempt and measure histories, and suggested-practice progress locally in the selected browser. Provide export and restore so browser storage is not the only copy.

Persist the score package before marking import complete. A failed import leaves existing pieces intact. Use score-version identifiers so replacing a source does not mix incompatible practice histories.

Source files, normalized score packages, practice MIDI, and results stay on the device. Import normalization and rendering use local browser processing; no import service receives files. Release transient import buffers and import-worker resources after success, failure, or cancellation without removing an already saved package. Export and restore are the way to transfer the library and practice history between the computer and iPad; browser storage is separate on each device.

Once a score and its sounds are cached, the practice engine must work without network round trips. Promise offline relaunch only after validating the selected browser's caching and storage behavior.

Save a resumable position during ordinary practice. After interruption, offer Resume from this position or Restart passage. A scored attempt is interrupted and must restart to produce a comparable result.

Prefer device wake prevention where the browser supports it, but recover correctly from screen locking, app switching, audio suspension, and memory pressure.

## Acceptance criteria

| Test | Passing behavior |
| --- | --- |
| Static hosting | The complete app runs from a GitHub Pages project URL. User MusicXML score imports require no server application, remote conversion API, or processing service; source files remain on the device. |
| Desktop browser | Standard desktop Chrome connects to the computer's available MIDI input and output through its normal permission flow; no specialist browser or native companion is required. |
| Actual target device | MIDIWeb Browser runs the app on the reference tablet (an older iPad with a touch screen on a current iPadOS) without developing or publishing a native app. |
| Free MIDI path | Required MIDI functions work without purchasing a browser feature. |
| USB and Bluetooth | Test both routes independently with the actual piano; only advertise routes that pass. |
| MIDI fidelity | A known sequence containing chords, repeated notes, releases, velocity changes, and pedal values produces no lost or duplicated events. |
| Pedal hints | One pedal press reveals one hint; holding it does not retrigger; the next press works after release. |
| Wrong note | A wrong key produces conspicuous red feedback and does not advance the current group. |
| Ottava error emphasis | With written C4 under 8va requiring sounding C5, both C4 and unrelated D5 immediately highlight the active marking and span. Correct C5 advances without an error. The warning does not wait for the note-name hint threshold. Equivalent behavior holds for octave-down and two-octave markings. |
| Ottava scope and visibility | Only spans active at the expected position on selected parts are emphasized; both-hands ambiguity highlights all applicable spans. Resting or tied voices preserve the marking's actual scope without extending it. An offscreen label produces a visible reminder beside the cursor. The warning persists until correct completion and clears on seeking, restarting, or interruption. |
| Ottava import consistency | MusicXML fixtures preserve written notation and ottava scope while matching, playback, octave labels, and keyboard rescue agree on the sounding pitches. Displacement is applied exactly once, and no warning appears for an inactive span. |
| Chord recovery | Correct partial attacks remain recognized after release and after a wrong attack. Once all required pitches are attacked, input completion occurs exactly once, even if an incorrect key remains held; automatic accompaniment also respects the musical-position gate. |
| Wide rolled chords | In the supplied reference piece, bar 23's A2–E3–C4 and bar 59's roll across both staves complete with correct successive presses, releasing earlier keys before later ones. No joint hold, minimum hold, or roll deadline is required. Test both hands and each selected hand. |
| Attack memory and sequence | Replaying an accepted pitch while a group is incomplete adds no progress or pitch error. It never fills a later group. A later untied repeat requires a fresh release-and-press cycle; ties and sustained sound create no fresh attacks. |
| Roll reference and timing | Marked direction and shared cross-staff membership produce the defined playback roll. Explicit performance offsets are not applied twice. The final roll's reference spread is included in an eligible multi-group attack-span target and scales with 0.5× and 2×; final holding time remains excluded. |
| Played versus held display | A correct note remains visibly completed after key release until its group advances. Physical key and sustain displays remain separate, and advancing or restarting clears accepted attacks for the old group. |
| Sustain and ties | Sustain cannot satisfy a new attack; a tie continuation needs no new press; a repeated untied pitch does. |
| Hints | Names follow the configured accidental and enharmonic-spelling preferences with correct octaves. Temporary hints fade out at the configured active-time expiry or on advancement unless persistent mode still requires the label. Keyboard rescue shows the exact keys. |
| Hint fade | Dismissal animates opacity smoothly without reflow or delayed score advancement. A timed label with no persistent visibility is fully invisible at expiry. A manual request during a fade restores the current group's hint and resets its timer; ordinary pause freezes the transition. Outgoing hints remain associated only with their original notes. |
| All-note labels | All notes mode labels every supported pitched note across both staves and the whole scrollable score without mistakes or Hint requests, including chords, tied continuations, read-ahead notes, and repeated occurrences. Rests remain unlabeled. |
| Conditional label boundaries | With G-clef rules below C4 or above C5, B3 and C♯5 are labeled; C4, E4, and C5 are not. Either rule can be disabled, and separately chosen F-clef thresholds do not affect G-clef labels. Invalid or reversed bounds receive clear feedback. |
| Conditional pitch and clef | Key-signature and carried accidentals affect eligibility correctly; enharmonic respelling does not. Written C5 under 8va qualifies for above C5 because its sounding pitch is C6. Clef changes and cross-staff notes use the governing displayed clef, independently of hand selection. Chords can contain both labeled and unlabeled notes. |
| Adjacent label layout | Dense chords, fast passages, ledger lines, and multiple voices remain readable with all qualifying labels beside their notes. Labels never cover adjacent notes or markings, are never silently omitted, and both staves retain onset alignment through zoom, orientation changes, and scrolling. |
| Persistent and temporary labels | Persistent labels survive group completion, pauses, and loop resets. A Hint request can reveal otherwise excluded notes without duplicate labels. Temporary expiry cannot hide a still-persistent label; disabling persistent mode cannot hide an active temporary hint. Labels fade only when neither visibility source remains. |
| Label assistance and persistence | Settings survive reload and export/restore. Visible persistent labels mark attempts as assisted, including exposure while waiting for the first key press and during read-ahead attributed to the revealed groups. Hiding labels cannot produce an unassisted result or false suggestion recovery; a conditional mode revealing nothing does not add assistance by itself. |
| Import mapping | MusicXML fixtures across supported file extensions and target browsers for simultaneous hands, unequal hand rhythms, ties across bars, pickups, tuplets, tempo changes, and alternative endings map every expected attack to its visible notes and produce the expected matching, hints, and timing. |
| Tempo mathematics | Four quarter-note attacks at quarter note = 60 yield a 3-second attack span. A complete 6/8 bar at dotted quarter = 60 has a 2-second nominal duration. |
| Loop boundaries | A tie crossing the loop start is reattacked deliberately; old notes and pedals do not satisfy the next attempt. |
| Hand practice | Right-only sends the left part to the connected piano, and left-only sends the right. Only human input for the selected part is graded. Both-hands mode sends no automatic part. |
| Interruption | Disconnect, backgrounding, setting changes, and pausing a scored attempt do not create a completed or failed result. Ordinary reading can pause and resume with its hint timer frozen. |
| Long piece | A proposed 500-measure test score scrolls and zooms without crashes or steadily increasing memory use on the target device. |
| Responsiveness | Proposed target: 95% of received MIDI events produce visible feedback within 50 ms. Measure from browser receipt to display, and report transport latency separately. |
| Endurance | A 30-minute practice session retains reliable matching, audio, pedal state, and saved progress. |
| Suggested practice | Three error-bearing complete passes out of five flag a bar; one bad pass does not. Unvisited or partial bars never count as clean, and device interruptions do not trigger repeated-restart suggestions. |
| Suggested passage action | Practice this passage opens the correct bars, hand, and tempo with context clearly distinguished. Suggestions never interrupt an active performance. |
| Suggestion recovery | Three consecutive clean, unassisted traversals resolve each flagged bar. Assisted success, practice at another tempo, and partial passes cannot falsely resolve it. |
| Supported file formats | .musicxml and .mxl import directly; .xml is accepted only when it contains a MusicXML score. No other score import format is supported. |
| MusicXML import validation | Malformed XML and compressed files receive clear errors. Missing numerical tempo and ambiguous hand assignments are resolved before scored practice; unsupported musical content is never silently dropped. |
| MusicXML timing | Numerical playback tempo and displayed dotted-beat metronome marks normalize correctly. Conflicting tempo values are reported for review. |
| Adjustable tempo | At source quarter note = 120, 0.5× plays at 60 and 2× at 240 with unchanged pitch. A passage lasting 20 seconds at 1× has targets of 40 seconds at 0.5× and 10 seconds at 2×. Custom values such as 0.6× and 1.8× also work. |
| Tempo synchronization | Both hands, individual hands, loops, playback cursor, pedals, and metronome use the selected factor while preserving source tempo changes. Hint timers remain in actual active seconds. |
| Tempo changes during use | Listen continues from the current position without stuck or duplicated notes. A scored attempt is interrupted on a tempo change and the next attempt uses a new comparison context and target duration. |
| Explicit accidentals | With the setting on, C♯ and B♭ appear in hints even when implied by the key signature or earlier in the measure. Cancellation to a natural is resolved correctly, without applying the key signature twice. |
| Enharmonic simplification | With the setting on, B♯4 becomes C5, C♭4 becomes B3, E♯4 becomes F4, F♭4 becomes E4, and double accidentals simplify correctly. With it off, original spelling remains. Ordinary E♭ is retained. |
| Hint preference combinations | All four on/off combinations produce unambiguous labels, including C♮5 for B♯4 in C♯ major when contextual accidentals and simplification are selected. Letter names, fixed do, keyboard labels, and optional octave display agree; underlying notes and pitches are unchanged. |
| Stack and production target | Pinned stable TypeScript builds strict-checked static assets. The production build works in the actual target browsers without shipping the compiler or relying on esnext-only APIs. |
| Deferred assets | Opening the library does not load the notation engine or piano samples. Build reports include both initial and practice-path totals. |
| Bounded notation | Traversing the 500-measure fixture repeatedly with all-note labels leaves mounted score segments and cached geometry within their bounds. No complete hidden SVG tree grows behind the visible strip. |
| Live rendering isolation | MIDI input updates only matching and necessary visuals; it does not trigger XML parsing, score-wide engraving, or whole-score reactive reconciliation. Feedback and frame-work targets pass on the actual iPad. |
| Import memory lifecycle | Import, cancellation, failure, and repeated imports dispose of worker and temporary resources. The device stays responsive and does not reload or accumulate import memory. |
| First-key timing | Start enters Ready without starting the clock. Idle waiting, hints, pedals, releases, and zero-velocity Note On do not start it. The first fresh positive-velocity Note On starts timing and is processed once, whether correct or wrong. |
| Immediate repeat readiness | After keys and sound-retaining pedals are released and reset finishes, the next loop enters Ready directly. Reset time is excluded, stale held notes cannot satisfy it, and a hint-pedal press in Ready neither starts timing nor cancels readiness. |
| Physical-piano Preview | Neither / Preview plays both parts audibly through the selected MIDI output, at the chosen tempo, with no learner input, errors, performance timer, or saved practice result. Browser sound never silently substitutes. |
| Accompaniment waiting | The automatic part follows tempo between learner onsets, plays its due notes once, and waits at an incomplete learner group. Early correct attacks remain counted, but cannot move the transport ahead of musical time. Resumption produces no repeated or burst playback. |
| Accompaniment timing | A genuine automatic introduction can play before the first human press without starting the stopwatch. A first human press, correct or wrong, starts it; output never does. Automatic endings and reset are excluded after the final required attack. |
| Output echo and ownership | Returned automatic notes cannot advance matching, start timing, trigger hints, or count as mistakes. Genuine simultaneous same-pitch human attacks remain detectable. Preview unisons, overlapping voices, shared learner pitches, and pedal ownership pass the actual-instrument tests. |
| MIDI output recovery | Pause, Stop, seeking, mode changes, tempo changes, and reconnection cancel obsolete output and clean up app-owned notes/controllers without cutting off unrelated learner sound. Test USB and BLE independently, including unavailable output and disconnection. |
| MIDI-only resource use | Physical-piano preview and accompaniment run without fetching or decoding the browser piano sample bank. |

These are release targets, not measured results. The device and import proofs must pass before committing to the full feature implementation.

## Implementation order and remaining inputs

First, prove both MIDI input and audible instrument-output paths in desktop Chrome and MIDIWeb on the target iPad, and the mapping from imported MusicXML events to visible notes. The import and rendering proof must run entirely in the browser from GitHub Pages. MIDI compatibility and correct MusicXML interpretation are the two feasibility gates.

Prototype the chosen TypeScript/Vite/Preact stack with the independent matching engine and the OSMD adapter. Before committing to that renderer, verify the reference piece's ottava, cross-staff hand assignment, rolled chords, ties, tuplets, and labels, then prove bounded rendering and MIDI responsiveness on the 500-measure fixture. The shell's small bundle size does not waive these score-engine checks.

Next, build one complete practice path: import a supported score, connect the piano, display the strip, match both hands, show red errors, and offer timed note-name hints through touch and pedal.

Then add persistent all-note and conditional score labels with collision-aware placement, keyboard rescue, passage selection, repeated attempts, suggested practice passages, the scorecard, reference playback, and individual-hand practice. Complete export, recovery, and long-score performance with labels enabled before calling the first release complete.

Future work can add strict rhythm assessment, note-length and pedal assessment, movable-do naming, richer ornament interpretation, and continuous-tempo performance mode.

The remaining user-specific inputs are the exact piano model, its connection hardware and receiving-channel capabilities, the intended desktop operating system, and representative MusicXML files. Measure pedal transmission, audible output, input echo, and shared-note/controller behavior during the connection test. MIDIWeb on iPad, standard Chrome on computers, free GitHub Pages hosting, and the absence of any server application are settled requirements. The repository destination is needed before deployment. The exact piano/browser combinations and MusicXML import/rendering performance still require validation.

