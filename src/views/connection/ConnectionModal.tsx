/**
 * The Connection and Pedal Setup modal: a large sheet over whichever view is current (the view
 * stays mounted, like Settings). Opened by the connection status chip (`openConnection`) or the
 * `#/connection` deep link; Back, Escape and the close button all close it.
 *
 * The setup content (`ConnectionView`) is a lazy chunk. The sheet mounts its children only while
 * open, so the chunk is not fetched, and the MIDI service is not touched, until first use.
 */
import { closeConnection, connectionOpen } from '../../app/navigation'
import { LazyView } from '../../app/LazyView'
import { Sheet } from '../../ui/controls'

export function ConnectionModal() {
  return (
    <Sheet title="Connection and Pedal Setup" open={connectionOpen.value} onClose={closeConnection} wide>
      <LazyView name="connection" />
    </Sheet>
  )
}
