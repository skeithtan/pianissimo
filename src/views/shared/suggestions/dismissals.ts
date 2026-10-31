import { SessionDismissals } from '../../../core/history'

/**
 * Suggestions dismissed "for this session". One shared instance so a suggestion dismissed in the
 * Library stays hidden in Results and vice versa. In memory only: a reload brings them back
 * (spec "Recognizing improvement").
 */
export const sessionDismissals = new SessionDismissals()
